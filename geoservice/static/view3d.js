/* view3d.js — режим «ВИД 2D/3D»: 3D-модель местности выбранного лесхоза.
 * Кнопка между «Моё местоположение» и «Полный экран».
 * Нажали кнопку → щёлкните по лесхозу на карте (или выберите в списке) → открывается
 * «пустая» 3D-модель местности в реальном размере контура из SHP (1 ед. сцены = 1 м).
 * Данные: /api/forest3d/* (forest3d_api.py), всё в WGS-84 (EPSG:4326).
 * Three.js r160 (MIT) — локально: /static/vendor/three/.
 */
(function () {
    'use strict';
    if (window.__view3dLoaded) return;
    window.__view3dLoaded = true;

    var API = '/api/forest3d';
    var THREE_URL = '/static/vendor/three/three.module.min.js';
    var ORBIT_URL = '/static/vendor/three/OrbitControls.js';
    var T = null, OrbitControls = null;
    var listCache = null;
    var picking = false, pickKey = null, prevDrawFlag = false, prevCursor = '';
    var accessState = null, uploadModal = null;
    var viewer = null;   // текущая 3D-сцена

    function toast(msg, err) { if (window.showToast) window.showToast(msg, !!err); }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
    function fmt(n, d) { return Number(n).toLocaleString('ru-RU', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }); }
    function getMap() { return window.map && typeof window.map.getView === 'function' ? window.map : null; }

    function loadThree() {
        if (T) return Promise.resolve();
        return import(THREE_URL).then(function (m) {
            T = m;
            return import(ORBIT_URL);
        }).then(function (m) { OrbitControls = m.OrbitControls; });
    }
    function getJSON(url, signal) {
        return fetch(url, { credentials: 'same-origin', cache: 'no-store', headers: { 'Accept': 'application/json' }, signal: signal }).then(function (r) {
            if (!r.ok) {
                var e = new Error(r.status === 404 ? 'Лесхоз не найден' :
                    r.status === 429 ? 'Слишком много запросов к 3D — повторите через минуту' :
                    (r.status === 401 || r.status === 403) ? 'Нет доступа к 3D — войдите в систему заново' :
                    'Сервер 3D недоступен (' + r.status + ')');
                e.status = r.status;
                throw e;
            }
            return r.json();
        });
    }
    function getList() {
        if (listCache) return Promise.resolve(listCache);
        return getJSON(API + '/list').then(function (j) { listCache = j.items || []; return listCache; });
    }

    /* Проверка доступа. Явный отказ (allowed:false, 401, 403) закрывает 3D.
       Временный сбой (сеть, 5xx, 429 от rate-limit nginx) НЕ закрывает открытую сцену
       и не прячет кнопку: сохраняется последнее известное состояние, повтор — позже. */
    var accessBusy = null, accessRetryT = 0;
    function applyAccess(a){
        accessState=a;
        var b=document.getElementById('map-view3d-btn');if(b)b.hidden=!a.allowed;
        if(a.allowed){buildBtn();if(b)b.style.display='';}
        else {if(b)b.style.display='none';if(viewer)closeViewer(false);if(picking)stopPick();if(uploadModal)uploadModal.close();}
        return a;
    }
    function refreshAccess(){
        if(accessBusy)return accessBusy;
        accessBusy=getJSON(API+'/access').then(function(a){
            clearTimeout(accessRetryT);
            return applyAccess(a&&typeof a==='object'?a:{allowed:false,is_admin:false,users_enabled:false});
        }).catch(function(e){
            if(e&&(e.status===401||e.status===403))return applyAccess({allowed:false,is_admin:false,users_enabled:false});
            clearTimeout(accessRetryT);accessRetryT=setTimeout(function(){if(!document.hidden)refreshAccess();},5000);
            return accessState||{allowed:false,is_admin:false,users_enabled:false,transient:true};
        }).finally(function(){accessBusy=null;});
        return accessBusy;
    }
    /* WebGL проверяется один раз; пробный контекст сразу освобождается (раньше — утечка контекста при каждом открытии) */
    var webglChecked = null;
    function hasWebGL(){
        if(webglChecked!==null)return webglChecked;
        try{
            var c=document.createElement('canvas'),gl=c.getContext('webgl2')||c.getContext('webgl');
            webglChecked=!!gl;
            if(gl){var ext=gl.getExtension('WEBGL_lose_context');if(ext)ext.loseContext();}
            c.width=c.height=1;
        }catch(e){webglChecked=false;}
        return webglChecked;
    }
    function buildAccessCard(v,left){
        if(!accessState||!accessState.is_admin)return;
        var ac=card('v3d-access','fa-lock','Доступ к 3D',true),b=ac.querySelector('.v3d-body');
        b.innerHTML='<label><input type="checkbox" '+(accessState.users_enabled?'checked':'')+'> Разрешить просмотр 3D пользователям</label><div class="note">По умолчанию только администратор. Разрешение сохраняется после перезапуска. Загрузка и удаление LAS остаются только у администратора.</div>';
        var input=b.querySelector('input');input.onchange=function(){
            input.disabled=true;
            fetch(API+'/access',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json','X-CSRFToken':csrf()},body:JSON.stringify({users_enabled:input.checked})})
                .then(function(r){if(!r.ok)throw new Error('Не удалось изменить доступ ('+r.status+')');return r.json();})
                .then(function(a){accessState=a;toast(a.users_enabled?'Просмотр 3D разрешён пользователям':'3D закрыт для пользователей');})
                .catch(function(e){input.checked=!!accessState.users_enabled;toast(e.message,true);}).finally(function(){input.disabled=false;});
        };left.appendChild(ac);
    }
    function locationHTML(m,buttons){
        var forests=m.forests||[],lns=m.forestries||[];
        if(!m.location_basis)return '';
        var html='<div class="v3d-location" style="margin:7px 0;font-size:12px"><b>LAS попал на территории: лесхозов — '+forests.length+', лесничеств — '+lns.length+'</b>';
        if(!forests.length)html+='<div>'+(m.location_basis==='LAS points'?'Точки не попали в известные границы лесхозов. Проверьте систему координат облака.':'Местоположение по доступным данным не определено. Нужен исходный LAS.')+'</div>';
        forests.forEach(function(f){
            html+='<div style="margin-top:5px">Лесхоз: <b>'+esc(f.name)+'</b> · '+fmt(f.points)+' точек'+(buttons?' <button type="button" data-location-code="'+esc(f.code)+'">Открыть 3D</button>':'')+'</div>';
            var children=lns.filter(function(r){return r.parent_code===f.code;});
            html+='<div>Лесничеств в этом лесхозе: '+children.length+'</div>';
            children.forEach(function(r){html+='<div style="padding-left:10px">'+esc(r.name)+' · '+fmt(r.points)+' точек'+(buttons?' <button type="button" data-location-code="'+esc(r.code)+'">Открыть</button>':'')+'</div>';});
        });
        if(m.culture_points)html+='<div>Точки у грунта (участки культур по вашему правилу): '+fmt(m.culture_points)+'</div>';
        if(m.outside_forest_points)html+='<div>Вне границ лесхозов: '+fmt(m.outside_forest_points)+' точек.</div>';
        if(m.location_basis!=='LAS points')html+='<div style="color:#ffd54a">Старая обработка: определено только по вершинам деревьев. Загрузите исходный LAS заново для проверки всех точек.</div>';
        return html+'</div>';
    }
    function openAutoUpload(){
        refreshAccess().then(function(a){
            if(!a.is_admin){toast('Загрузка LAS доступна только администратору',true);return;}
            if(uploadModal)uploadModal.close();injectCSS();
            var ov=document.createElement('div');ov.id='v3d-upload-modal';
            ov.style.cssText='position:fixed;inset:0;z-index:11000;background:rgba(10,25,15,.75);display:flex;align-items:center;justify-content:center;color:#e8f5e9;font:13px Arial,sans-serif';
            ov.innerHTML='<div style="max-height:90vh;overflow:auto;background:#172b1c;border:1px solid #82e938;border-radius:14px;padding:18px;width:620px;max-width:90vw"><button type="button" data-close style="float:right">Закрыть</button><h3>Загрузить LAS без выбора местоположения</h3><div>Лесхозы и лесничества будут определены автоматически по всем точкам облака. Если LAS пересекает границу, будут показаны все территории.</div><div class="v3d-up"></div><div class="v3d-location-result" style="margin-top:12px"></div></div>';
            document.body.appendChild(ov);
            var v={alive:true,uploadOnly:true,code:'',data:{},lasCard:ov,clouds:{},filter:{1:true,2:true}};
            v.close=function(){v.alive=false;if(v.xhr)v.xhr.abort();ov.remove();if(uploadModal===v)uploadModal=null;};
            uploadModal=v;ov.querySelector('[data-close]').onclick=v.close;
            ov.addEventListener('click',function(e){var el=e.target.closest('[data-location-code]');if(el){var code=el.dataset.locationCode;v.close();window.forest3d.open(code);}});
            buildUpload(v);
            var previous=null;try{previous=localStorage.getItem('forest3d:last-job');}catch(e){}
            if(previous&&/^[0-9a-f]{12}$/.test(previous)){
                var resume=document.createElement('button');resume.type='button';resume.textContent='Проверить последнее задание LAS ('+previous+')';
                resume.style.marginTop='10px';resume.onclick=function(){watchJob(v,previous);};
                ov.querySelector('.v3d-location-result').before(resume);
            }
        });
    }

    /* ───────────────────────── стили ───────────────────────── */
    function injectCSS() {
        if (document.getElementById('view3d-css')) return;
        var st = document.createElement('style');
        st.id = 'view3d-css';
        st.textContent = [
            '#map-view3d-btn{position:fixed;right:10px;bottom:calc(14px + var(--mib-btn-size,40px) + 26px);z-index:1300;',
            ' width:calc(var(--mib-btn-size,40px) + 16px);height:calc(var(--mib-btn-size,40px) + 16px);border-radius:18px;',
            ' border:none!important;background:transparent!important;color:var(--icon-accent,#82e938);cursor:pointer;',
            ' display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;box-shadow:none!important;',
            ' transition:color .18s,opacity .15s;pointer-events:auto;font-size:var(--mib-icon-size,17px);outline:none!important;',
            ' -webkit-tap-highlight-color:transparent!important;padding:0}',
            '#map-view3d-btn:hover{opacity:.75}',
            '#map-view3d-btn:focus,#map-view3d-btn:focus-visible,#map-view3d-btn:active{outline:none!important;box-shadow:none!important;background:transparent!important}',
            '#map-view3d-btn .v3d-lbl{font:800 10px/1 Lato,Arial,sans-serif;letter-spacing:.5px}',
            '#map-view3d-btn .mib-tip{right:calc(100% + 8px);top:50%;transform:translateY(-50%);bottom:auto}',
            '#map-view3d-btn:hover .mib-tip{opacity:1}',
            '#map-view3d-btn.v3d-on{color:#ffd54a}',
            '#map-view3d-btn.v3d-pick i{animation:v3d-pulse 1.2s ease-in-out infinite}',
            '@keyframes v3d-pulse{0%,100%{filter:none}50%{filter:drop-shadow(0 0 6px currentColor)}}',
            /* геолокация — на одну позицию выше, освобождая место кнопке 3D */
            '#map-geoloc-btn{bottom:calc(14px + 2 * (var(--mib-btn-size,40px) + 26px))!important}',
            'body.fullscreen-mode #map-geoloc-btn{bottom:calc(14px + 2 * (var(--mib-btn-size,40px) + 26px))!important}',
            'body.fullscreen-mode #map-view3d-btn{position:fixed!important;right:10px!important;z-index:10002!important;pointer-events:auto!important}',
            /* выбор лесхоза */
            '#v3d-upload-modal button,#v3d-upload-modal select,#v3d-upload-modal input[type=text]{padding:6px 9px;background:#24452a;border:1px solid #6a9d54;color:#e8f5e9;border-radius:6px;cursor:pointer}',
            '#v3d-upload-modal .row{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}',
            '#v3d-upload-modal .note,#v3d-upload-modal .sub{font-size:12px;color:#aec5aa;margin-top:7px}',
            '#v3d-upload-modal .bar{height:6px;background:#344e37}#v3d-upload-modal .bar i{display:block;height:100%;background:#82e938}',
            '#v3d-picker{position:fixed;right:calc(var(--mib-btn-size,40px) + 34px);bottom:14px;z-index:1301;width:350px;max-width:calc(100vw - 24px);max-height:min(78vh,660px);',
            ' display:flex;flex-direction:column;background:rgba(18,32,20,.94);color:#e8f5e9;border:1px solid rgba(130,233,56,.35);',
            ' border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.45);font:13px/1.35 Lato,Arial,sans-serif;overflow:hidden;backdrop-filter:blur(6px)}',
            'body.fullscreen-mode #v3d-picker{z-index:10003}',
            '#v3d-picker .v3d-ph{padding:10px 12px 6px;font-weight:700;display:flex;align-items:center;gap:8px}',
            '#v3d-picker .v3d-ph i{color:var(--icon-accent,#82e938)}',
            '#v3d-picker .v3d-ph button{margin-left:auto;background:none;border:none;color:#cfd8cf;font-size:16px;cursor:pointer}',
            '#v3d-picker .v3d-hint{padding:0 12px 8px;color:#a8c3a8;font-size:12px}',
            '#v3d-picker > input{margin:0 12px 8px;padding:7px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.18);background:rgba(0,0,0,.3);color:#fff;outline:none}',
            '#v3d-picker > input:focus{border-color:var(--icon-accent,#82e938)}',
            '#v3d-picker > ul{list-style:none;margin:0;padding:0 6px 8px;overflow:auto;flex:1}',
            '#v3d-picker > ul > li{display:flex;justify-content:space-between;gap:8px;padding:6px 8px;border-radius:7px;cursor:pointer}',
            '#v3d-picker > ul > li:hover,#v3d-picker > ul > li.sel{background:rgba(130,233,56,.16)}',
            '#v3d-picker > ul > li small{color:#9fb59f;white-space:nowrap}',
            '#v3d-picker > ul{min-height:96px}#v3d-picker .v3d-autoup{margin:0 12px 8px;padding:6px 8px;background:transparent;color:#cfe9cf;border:1px dashed rgba(130,233,56,.45);border-radius:8px;cursor:pointer;font-size:12px;text-align:left}#v3d-picker .v3d-autoup:hover{background:rgba(130,233,56,.08)}',
            /* 3D-окно: fixed по ВИДИМОЙ части карты (без боковой панели), см. fitOverlay() */
            '#v3d-overlay{position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:1200;background:linear-gradient(180deg,#8fb9d6 0%,#cfe0ea 55%,#e9efe9 100%);',
            ' overflow:hidden;font:13px/1.35 Lato,Arial,sans-serif;color:#e8f5e9;user-select:none}',
            'body.fullscreen-mode #v3d-overlay{z-index:10001}',
            '#v3d-overlay canvas{display:block;width:100%;height:100%;outline:none}',
            '#v3d-overlay .v3d-forestry-labels{position:absolute;inset:0;pointer-events:none;z-index:1;overflow:hidden}',
            '#v3d-overlay .v3d-forestry-label{position:absolute;transform:translate(-50%,-50%);max-width:150px;width:max-content;padding:3px 7px;',
            ' color:#e5faff;background:rgba(10,31,24,.76);border:1px solid rgba(112,221,255,.55);border-radius:6px;',
            ' font:600 12px/1.2 Arial,sans-serif;text-align:center;overflow-wrap:anywhere;text-shadow:0 1px 2px #000;box-shadow:0 1px 5px rgba(0,0,0,.2)}',
            '#v3d-left{z-index:3}',

            '#v3d-overlay .v3d-card{background:rgba(16,30,18,.88);border:1px solid rgba(130,233,56,.28);border-radius:12px;',
            ' box-shadow:0 6px 22px rgba(0,0,0,.3);backdrop-filter:blur(5px)}',
            '#v3d-overlay .v3d-abs{position:absolute;z-index:3}',
            '#v3d-left{position:absolute;left:12px;top:12px;width:348px;max-width:calc(100% - 24px);max-height:calc(100% - 64px);overflow-y:auto;overflow-x:hidden;',
            ' display:flex;flex-direction:column;gap:8px;scrollbar-width:thin;scrollbar-color:rgba(130,233,56,.4) transparent;padding-right:2px}',
            '#v3d-left .v3d-card{padding:10px 12px;flex:0 0 auto}',
            '#v3d-toggle{left:368px;top:12px;padding:6px 9px;color:#e8f5e9;cursor:pointer;font:12px Lato,Arial,sans-serif;z-index:2}',
            '#v3d-toggle.hid{left:12px}',
            '#v3d-toggle:hover{color:#82e938}',
            '#v3d-left h3{margin:0 0 2px;font-size:15px;color:#fff;display:flex;align-items:center;gap:8px}',
            '#v3d-left h4{margin:0;font-size:13px;color:#fff;display:flex;align-items:center;gap:7px;cursor:pointer}',
            '#v3d-left h4 i.fa-chevron-down{margin-left:auto;transition:transform .15s;color:#a8c3a8}',
            '#v3d-left .collapsed h4 i.fa-chevron-down{transform:rotate(-90deg)}',
            '#v3d-left .collapsed .v3d-body{display:none}',
            '#v3d-left .v3d-body{margin-top:7px}',
            '#v3d-left .sub{color:#a8c3a8;font-size:12px}',
            '#v3d-left table{border-collapse:collapse;width:100%}',
            '#v3d-left td{padding:2px 0;vertical-align:top}',
            '#v3d-left td:first-child{color:#a8c3a8;padding-right:10px;white-space:nowrap}',
            '#v3d-left td b{color:#fff}',
            '#v3d-left .row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:5px 0}',
            '#v3d-left label{color:#a8c3a8}',
            '#v3d-left input[type=range]{flex:1;min-width:80px;accent-color:#82e938}',
            '#v3d-left button,#v3d-left select,#v3d-left input[type=text]{background:rgba(130,233,56,.12);color:#e8f5e9;border:1px solid rgba(130,233,56,.35);border-radius:8px;padding:4px 8px;font:inherit;font-size:12px}',
            '#v3d-left select option{background:#16281a}',
            '#v3d-left button{cursor:pointer}',
            '#v3d-left button:hover{background:rgba(130,233,56,.26)}',
            '#v3d-left button.on{background:#82e938;color:#10220f;font-weight:700}',
            '#v3d-left .v3d-tq-st{font-size:11px;color:#c9d6bf;margin-left:2px}',
            '#v3d-left button.close{background:rgba(255,213,74,.16);border-color:rgba(255,213,74,.5)}',
            '#v3d-left button.primary{background:#82e938;color:#10220f;font-weight:700}',
            '#v3d-left .note{color:#8fa98f;font-size:11px;margin-top:4px}',
            '#v3d-left .cl{border-top:1px solid rgba(255,255,255,.08);padding:6px 0}',
            '#v3d-left .cl:first-child{border-top:none}',
            '#v3d-left .cl .t{display:flex;align-items:center;gap:6px}',
            '#v3d-left .cl .t span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#fff}',
            '#v3d-left .cl .t button{padding:2px 6px}',
            '#v3d-left .cl .s{color:#a8c3a8;font-size:11.5px;margin-left:22px}',
            '#v3d-left .bar{height:5px;border-radius:3px;background:rgba(255,255,255,.12);overflow:hidden;margin:4px 0 0 22px}',
            '#v3d-left .bar i{display:block;height:100%;background:#82e938;transition:width .3s}',
            '#v3d-left .lg{display:inline-block;width:10px;height:10px;border-radius:2px;vertical-align:-1px;margin-right:3px}',
            '#v3d-left .hc{display:grid;grid-template-columns:auto 1fr auto;gap:2px 6px;font-size:11.5px;align-items:center;margin-top:4px}',
            '#v3d-left .hc .b{height:8px;border-radius:2px;display:flex;overflow:hidden;background:rgba(255,255,255,.06)}',
            '#v3d-left .hc .b i{display:block;height:100%}',
            '#v3d-coords{left:50%;transform:translateX(-50%);bottom:12px;padding:6px 12px;max-width:calc(100% - 24px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}',
            '#v3d-compass{right:calc(var(--mib-btn-size,40px) + 40px);top:12px;width:58px;height:58px;border-radius:50%!important;display:flex;align-items:center;justify-content:center;cursor:pointer}',
            '#v3d-compass svg{width:46px;height:46px}',
            '#v3d-scale{right:calc(var(--mib-btn-size,40px) + 40px);top:80px;padding:5px 10px;font-size:12px}',
            '#v3d-help{left:50%;top:12px;transform:translateX(-50%);padding:5px 12px;font-size:12px;color:#cfe0cf;white-space:nowrap}',
            '#v3d-loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#10220f;font-size:15px;font-weight:700;gap:10px}',
            '#v3d-loading i{font-size:22px}',
            /* ── v16: полировка HUD 3D — единые токены, фокус с клавиатуры, контраст, состояния ── */
            '#v3d-overlay{--v3d-accent:#82e938;--v3d-ink:#10220f;--v3d-bg:rgba(14,27,17,.9);--v3d-line:rgba(130,233,56,.26);--v3d-muted:#a9c2a6;--v3d-text:#eaf5e8;font-family:Inter,Lato,"Segoe UI",Roboto,Arial,sans-serif}',
            '#v3d-overlay .v3d-card{background:var(--v3d-bg);border-color:var(--v3d-line);border-radius:14px;box-shadow:0 8px 28px rgba(0,0,0,.32),inset 0 1px 0 rgba(255,255,255,.04)}',
            '#v3d-left{gap:10px;width:356px}',
            '#v3d-left .v3d-card{padding:11px 13px}',
            '#v3d-left h4{font-size:13.5px;font-weight:700;letter-spacing:.1px;min-height:28px;user-select:none}',
            '#v3d-left h4>i:first-child{color:var(--v3d-accent);width:18px;text-align:center}',
            '#v3d-left .note{color:#a3bba0;font-size:11.5px;line-height:1.45}',
            '#v3d-left .sub{color:var(--v3d-muted)}',
            '#v3d-left button,#v3d-left select,#v3d-left input[type=text]{min-height:30px;padding:5px 10px;border-radius:9px;transition:background .15s,border-color .15s,color .15s}',
            '#v3d-left button:disabled,#v3d-left input:disabled,#v3d-left select:disabled{opacity:.45;cursor:not-allowed}',
            '#v3d-left input[type=checkbox],#v3d-left input[type=range]{accent-color:var(--v3d-accent)}',
            '#v3d-overlay :focus-visible{outline:2px solid #ffd54a!important;outline-offset:2px}',
            '#map-view3d-btn:focus-visible{outline:2px solid #ffd54a!important;outline-offset:2px;border-radius:12px}',
            '#v3d-left::-webkit-scrollbar{width:8px}#v3d-left::-webkit-scrollbar-thumb{background:rgba(130,233,56,.35);border-radius:8px}',
            '#v3d-dem .v3d-body p,#v3d-dem .v3d-body label,#v3d-map-layers .v3d-body p{font-size:12.5px!important;line-height:1.45!important;color:var(--v3d-muted)}',
            '#v3d-dem [data-dem-status],#v3d-map-layers [data-map-status]{color:var(--v3d-text)!important;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:9px;padding:7px 9px}',
            '#v3d-map-layers [data-map-status]:empty{display:none}',
            '#v3d-dem button,#v3d-map-layers button{min-height:32px!important;font-size:12.5px!important}',
            '#v3d-map-layers .v3d-map-choices label{min-height:34px!important;font-size:13px!important;color:var(--v3d-text)!important}',
            '#v3d-map-layers .v3d-map-choices input{width:18px!important;height:18px!important;flex:0 0 18px!important}',
            '#v3d-dem h4,#v3d-map-layers h4{justify-content:space-between}',
            '#v3d-dem.collapsed .v3d-body,#v3d-map-layers.collapsed .v3d-body{display:none}',
            '#v3d-ctxlost{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:6;display:flex;gap:12px;align-items:flex-start;max-width:min(470px,calc(100% - 32px));padding:16px 18px;background:rgba(36,18,12,.95);border:1px solid rgba(255,170,90,.6);border-radius:14px;color:#ffeede;box-shadow:0 12px 36px rgba(0,0,0,.45);font-size:13px;line-height:1.45}',
            '#v3d-ctxlost i{color:#ffb070;font-size:20px;margin-top:2px}',
            '#v3d-ctxlost button{display:none;margin-left:auto;align-self:center;white-space:nowrap;background:#ffb070;color:#2a1408;border:0;border-radius:9px;padding:7px 12px;font-weight:700;cursor:pointer}',
            '#v3d-ctxlost.stuck button{display:inline-block}',
            '#v3d-coords,#v3d-help,#v3d-scale{border-radius:999px!important}',
            '#v3d-coords{padding:7px 14px;font-size:12.5px}',
            '#v3d-loading{flex-direction:column;color:#123018;text-shadow:0 1px 0 rgba(255,255,255,.5)}',
            '#v3d-loading::after{content:"";width:180px;height:4px;border-radius:4px;background:linear-gradient(90deg,transparent,#2f7a3d,transparent);background-size:200% 100%;animation:v3d-load 1.2s linear infinite}',
            '@keyframes v3d-load{from{background-position:200% 0}to{background-position:-200% 0}}',
            '@media (prefers-reduced-motion:reduce){#v3d-overlay *,#v3d-overlay *::after,#map-view3d-btn *{animation:none!important;transition:none!important}}',
            '@media (forced-colors:active){#v3d-overlay .v3d-card{border:1px solid CanvasText}}',
            '@media (max-width:1100px){#v3d-help{display:none}}',
            '@media (max-width:760px){#v3d-left{width:calc(100% - 110px)}#v3d-toggle{left:auto;right:12px;top:auto;bottom:12px}#v3d-toggle.hid{left:12px;right:auto}#v3d-coords{display:none}#v3d-scale{display:none}}',
            '@media (max-height:620px){#v3d-left{max-height:calc(100% - 24px)}#v3d-coords{display:none}}'
        ].join('\n');
        document.head.appendChild(st);
    }

    /* ───────────────────────── кнопка ───────────────────────── */
    function setBtnState() {
        var b = document.getElementById('map-view3d-btn');
        if (!b) return;
        var on = !!viewer;
        b.classList.toggle('v3d-on', on);
        b.classList.toggle('v3d-pick', picking);
        b.querySelector('.v3d-lbl').textContent = on ? '2D' : '3D';
        b.querySelector('i').className = 'fa-solid ' + (on ? 'fa-map' : 'fa-cube');
        b.querySelector('.mib-tip').textContent = on ? 'Вид 2D — вернуться к карте' : (picking ? 'Отменить выбор' : 'Вид 2D/3D — 3D-модель лесхоза');
        b.title = on ? 'Вид 2D' : 'Вид 2D/3D';
    }
    function buildBtn() {
        if (!accessState || !accessState.allowed || document.getElementById('map-view3d-btn')) return;
        injectCSS();
        var b = document.createElement('button');
        b.id = 'map-view3d-btn';
        b.type = 'button';
        b.setAttribute('aria-label', 'Вид 2D/3D');
        b.innerHTML = '<i class="fa-solid fa-cube"></i><span class="v3d-lbl">3D</span><span class="mib-tip">Вид 2D/3D</span>';
        b.addEventListener('click', function (e) {
            e.preventDefault(); e.stopPropagation();
            if (viewer) { closeViewer(true); return; }
            if (picking) { stopPick(); return; }
            startPick();
        });
        var gl = document.getElementById('map-geoloc-btn');
        var fs = document.getElementById('map-fullscreen-btn');
        var parent = (fs && fs.parentElement) || (gl && gl.parentElement) || document.body;
        parent.insertBefore(b, fs || null);
        setBtnState();
    }

    /* ───────────────────────── выбор лесхоза ───────────────────────── */
    function startPick() {
        if(!accessState || !accessState.allowed){refreshAccess().then(function(a){if(a.allowed)startPick();else toast('3D доступен только администратору',true);});return;}
        var map = getMap();
        if (!map) { toast('Карта ещё загружается', true); return; }
        picking = true;
        prevDrawFlag = !!window._msrDrawingActive;
        window._msrDrawingActive = true;      // глушим идентификацию слоёв на время выбора
        var tgt = map.getTargetElement();
        prevCursor = tgt.style.cursor;
        tgt.style.cursor = 'crosshair';
        pickKey = map.on('singleclick', onPickClick);
        document.addEventListener('keydown', onKey, true);
        showPicker();
        setBtnState();
        toast('3D: щёлкните по лесхозу на карте или выберите его в списке');
        loadThree().catch(function () {});   // прогрев
    }
    function stopPick() {
        if (!picking) return;
        picking = false;
        var map = getMap();
        if (map) {
            if (pickKey && window.ol && ol.Observable) ol.Observable.unByKey(pickKey);
            map.getTargetElement().style.cursor = prevCursor || '';
        }
        pickKey = null;
        window._msrDrawingActive = prevDrawFlag;
        if (!viewer) document.removeEventListener('keydown', onKey, true);
        var p = document.getElementById('v3d-picker');
        if (p) p.remove();
        setBtnState();
    }
    function onKey(e) {
        if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
        if (document.getElementById('llw-modal')) return;   // Esc закрывает окно ЛесоЛидар, а не 3D/выбор
        var t = e.target, tag = t && t.tagName;
        if (viewer && t && t !== document.body && viewer.ov && viewer.ov.contains(t) &&
            (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || t.isContentEditable)) {
            try { t.blur(); } catch (_) {}       // первый Esc — выйти из поля, а не из 3D
            return;
        }
        if (viewer && viewer.drone && viewer.drone.active) return;   // Esc обрабатывает режим БПЛА
        if (viewer) { closeViewer(true); e.stopPropagation(); }
        else if (picking) { stopPick(); e.stopPropagation(); }
    }
    function onPickClick(evt) {
        var map = getMap();
        var ll = ol.proj.toLonLat(evt.coordinate, map.getView().getProjection());
        getJSON(API + '/at?lon=' + ll[0].toFixed(6) + '&lat=' + ll[1].toFixed(6)).then(function (j) {
            if (!j.found) { toast('В этой точке нет лесхоза — щёлкните внутри границы лесхоза', true); return; }
            openViewer(j.code);
        }).catch(function (e) { toast(e.message, true); });
    }
    function mapCenterLonLat() {
        var map = getMap(); if (!map || !window.ol) return null;
        try { var v = map.getView(); return ol.proj.toLonLat(v.getCenter(), v.getProjection()); } catch (e) { return null; }
    }
    function showPicker() {
        var old = document.getElementById('v3d-picker');
        if (old) old.remove();
        var p = document.createElement('div');
        p.id = 'v3d-picker';
        p.innerHTML = '<div class="v3d-ph"><i class="fa-solid fa-cube"></i>3D-модель лесхоза<button type="button" title="Отмена">&times;</button></div>' +
            '<div class="v3d-hint">Щёлкните по лесхозу на карте или выберите из списка</div>' +
            '<select style="margin:0 12px 8px;padding:6px;background:#16281a;color:white" aria-label="Уровень 3D"><option value="forest">Лесхозы</option><option value="forestry">Лесничества</option></select>' +
            '<input type="search" placeholder="Поиск по названию…" autocomplete="off">' +
            '<ul><li style="cursor:default;color:#a8c3a8">Загрузка списка…</li></ul>';
        document.body.appendChild(p);
        p.querySelector('.v3d-ph button').onclick = stopPick;
        // v19: блок «Обработка LAS · ЛесоЛидар» — самым верхним разделом окна выбора (над списком лесхозов)
        if(window.LesoLidarWeb){try{window.LesoLidarWeb.pickerBlock(p,{mapCenter:mapCenterLonLat,stopPick:stopPick,openViewer:openViewer});}catch(e){console.warn('ЛесоЛидар:',e);}}
        if(accessState&&accessState.is_admin){
            var ub=document.createElement('button');ub.type='button';ub.className='v3d-autoup';
            ub.innerHTML='<i class="fa-solid fa-upload"></i> Быстрая загрузка LAS в 3D — место определится автоматически';
            ub.title='Прежний режим: облако → деревья хвойные/лиственные прямо в 3D-сцене. Для таксации (породы, запас, отчёты) — «Новая обработка» выше.';
            p.insertBefore(ub,p.querySelector(':scope > input'));ub.onclick=function(){stopPick();openAutoUpload();};
        }
        // :scope > … — в окне есть вложенный блок ЛесоЛидар со своим списком <ul>
        var inp = p.querySelector(':scope > input'), ul = p.querySelector(':scope > ul'), mode = p.querySelector(':scope > select'), forestryList = null;
        ['pointerdown', 'wheel', 'keydown'].forEach(function (ev) { p.addEventListener(ev, function (e) { e.stopPropagation(); }); });
        function render() {
            var source = mode.value === 'forestry' ? forestryList : listCache;
            if (!source) return;
            var q = inp.value.trim().toLowerCase();
            var items = source.filter(function (d) { return !q || d.name.toLowerCase().indexOf(q) >= 0 || String(d.code).indexOf(q) === 0; });
            ul.innerHTML = items.length ? items.map(function (d) {
                return '<li data-code="' + esc(d.code) + '"><span>' + esc(d.name) + (d.parent_name ? ' · ' + esc(d.parent_name) : '') +
                    (withClouds[d.code] ? ' <i class="fa-solid fa-tree" style="color:#82e938" title="Есть деревья из облаков точек: ' + fmt(withClouds[d.code]) + '"></i>' : '') +
                    '</span><small>' + fmt(d.area_ha) + ' га</small></li>';
            }).join('') : '<li style="cursor:default;color:#a8c3a8">Ничего не найдено</li>';
        }
        ul.addEventListener('click', function (e) {
            var li = e.target.closest('li[data-code]');
            if (li) openViewer(li.getAttribute('data-code'));
        });
        mode.addEventListener('change',function(){
            if(mode.value==='forestry'&&!forestryList){
                ul.innerHTML='<li>Загрузка лесничеств…</li>';
                getJSON(API+'/list?kind=forestry').then(function(j){forestryList=j.items;render();})
                    .catch(function(e){ul.innerHTML='<li>'+esc(e.message)+'</li>';});
            }else render();
        });
        inp.addEventListener('input', render);
        inp.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { var li = ul.querySelector('li[data-code]'); if (li) openViewer(li.getAttribute('data-code')); }
            if (e.key === 'Escape') stopPick();
        });
        var withClouds = {};
        getList().then(function () {
            render();
            return getJSON(API + '/las').then(function (j) {
                (j.items || []).forEach(function (c) { if (c.state === 'done' && c.code) withClouds[c.code] = (withClouds[c.code] || 0) + (c.trees || 0); });
                render();
            }).catch(function () {});
        }).catch(function (e) { ul.innerHTML = '<li style="cursor:default;color:#ff9d9d">' + esc(e.message) + '</li>'; });
        setTimeout(function () { try { inp.focus({ preventScroll: true }); } catch (e) {} }, 50);
    }

    /* ───────────────────────── рельеф (условный) ───────────────────────── */
    function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
    function makePerlin(seed) {
        var rnd = mulberry32(seed), p = new Uint8Array(512), i, j, t;
        var perm = []; for (i = 0; i < 256; i++) perm[i] = i;
        for (i = 255; i > 0; i--) { j = Math.floor(rnd() * (i + 1)); t = perm[i]; perm[i] = perm[j]; perm[j] = t; }
        for (i = 0; i < 512; i++) p[i] = perm[i & 255];
        function fade(x) { return x * x * x * (x * (x * 6 - 15) + 10); }
        function grad(h, x, y) { switch (h & 7) { case 0: return x + y; case 1: return -x + y; case 2: return x - y; case 3: return -x - y; case 4: return x; case 5: return -x; case 6: return y; default: return -y; } }
        return function (x, y) {
            var X = Math.floor(x), Y = Math.floor(y); x -= X; y -= Y; X &= 255; Y &= 255;
            var u = fade(x), v = fade(y), a = p[X] + Y, b = p[X + 1] + Y;
            var n00 = grad(p[a], x, y), n10 = grad(p[b], x - 1, y), n01 = grad(p[a + 1], x, y - 1), n11 = grad(p[b + 1], x - 1, y - 1);
            return (n00 + u * (n10 - n00)) + v * ((n01 + u * (n11 - n01)) - (n00 + u * (n10 - n00)));
        };
    }
    /* высота, м: мягкий равнинный рельеф (холмы/ложбины, как у типичной белорусской местности) */
    function makeHeightFn(code) {
        var seed = 0, s = String(code);
        for (var i = 0; i < s.length; i++) seed = (seed * 31 + s.charCodeAt(i)) | 0;
        var n = makePerlin(seed ^ 0x5bd1e995);
        var oct = [[14000, 22], [6000, 11], [2500, 5], [900, 1.8], [350, 0.6]];
        return function (x, y) {   // x — восток, y — север (м)
            var h = 0;
            for (var k = 0; k < oct.length; k++) h += n(x / oct[k][0] + k * 17.3, y / oct[k][0] - k * 9.1) * oct[k][1];
            return h;
        };
    }

    /* ───────────────────────── геометрия ───────────────────────── */
    function niceStep(v) { var p = Math.pow(10, Math.floor(Math.log10(v))), m = v / p; return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p; }
    function densify(ring, step) {
        var out = [];
        for (var i = 0; i < ring.length - 1; i++) {
            var a = ring[i], b = ring[i + 1], dx = b[0] - a[0], dy = b[1] - a[1];
            var n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / step));
            for (var k = 0; k < n; k++) out.push([a[0] + dx * k / n, a[1] + dy * k / n]);
        }
        if (out.length) out.push(out[0].slice());
        return out;
    }
    function pointInRings(x, y, polys) {
        for (var p = 0; p < polys.length; p++) {
            var inside = false;
            for (var r = 0; r < polys[p].length; r++) {
                var ring = polys[p][r], c = false;
                for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                    var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
                    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
                }
                if (r === 0) inside = c; else if (c) inside = false;
            }
            if (inside) return true;
        }
        return false;
    }
    /* Внутренняя точка подписи: самая крупная часть полигона, с учётом отверстий. */
    function ringArea(r) { var a=0;for(var i=0,j=r.length-1;i<r.length;j=i++)a+=r[j][0]*r[i][1]-r[i][0]*r[j][1];return a/2; }
    function forestryLabelAnchor(polys) {
        function area(r) { var a=0;for(var i=0,j=r.length-1;i<r.length;j=i++)a+=r[j][0]*r[i][1]-r[i][0]*r[j][1];return Math.abs(a)/2; }
        var parts=polys.filter(function(p){return p.length&&p[0].length>=3;});
        parts.sort(function(a,b){return (area(b[0])-b.slice(1).reduce(function(v,r){return v+area(r);},0))-(area(a[0])-a.slice(1).reduce(function(v,r){return v+area(r);},0));});
        if(!parts.length)return null;
        var poly=parts[0], xmin=Infinity,ymin=Infinity,xmax=-Infinity,ymax=-Infinity;
        poly[0].forEach(function(q){xmin=Math.min(xmin,q[0]);xmax=Math.max(xmax,q[0]);ymin=Math.min(ymin,q[1]);ymax=Math.max(ymax,q[1]);});
        if(!(xmax>xmin&&ymax>ymin))return null;
        function clearance(x,y) {
            if(!pointInRings(x,y,[poly]))return -1;
            var d=Infinity;
            poly.forEach(function(r){for(var i=0,j=r.length-1;i<r.length;j=i++){
                var a=r[j],b=r[i],dx=b[0]-a[0],dy=b[1]-a[1],len=dx*dx+dy*dy;
                var t=len?Math.max(0,Math.min(1,((x-a[0])*dx+(y-a[1])*dy)/len)):0;
                d=Math.min(d,Math.hypot(x-a[0]-t*dx,y-a[1]-t*dy));
            }});return d;
        }
        var best=null,score=-1;
        function consider(x,y){var d=clearance(x,y);if(d>score){score=d;best=[x,y];}}
        // Scanlines guarantee candidates inside even concave polygons / holes.
        for(var row=0;row<17;row++){
            var y=ymin+(ymax-ymin)*(row+0.5)/17,cross=[];
            poly.forEach(function(r){for(var i=0,j=r.length-1;i<r.length;j=i++){
                var a=r[j],b=r[i];if((a[1]>y)!==(b[1]>y))cross.push(a[0]+(y-a[1])*(b[0]-a[0])/(b[1]-a[1]));
            }});
            cross.sort(function(a,b){return a-b;});
            for(var k=0;k+1<cross.length;k+=2)consider((cross[k]+cross[k+1])/2,y);
        }
        if(!best)return null;
        var step=Math.max(xmax-xmin,ymax-ymin)/8;
        for(var round=0;round<9;round++){
            var base=best.slice();for(var ix=-1;ix<=1;ix++)for(var iy=-1;iy<=1;iy++)consider(base[0]+ix*step,base[1]+iy*step);
            step/=2;
        }
        return best;
    }

    /* обратная AEQD (WGS-84) для курсора: локальные метры → долгота/широта */
    function makeInverse(lon0, lat0) {
        var a = 6378137, f = 1 / 298.257223563, e2 = f * (2 - f), D = Math.PI / 180;
        var s = Math.sin(lat0 * D), w = Math.sqrt(1 - e2 * s * s);
        var M = a * (1 - e2) / (w * w * w), N = a / w, R = Math.sqrt(M * N);
        var phi0 = lat0 * D;
        return function (x, y) {
            var xs = x * R / N, ys = y * R / M, rho = Math.hypot(xs, ys);
            if (rho < 1e-6) return [lon0, lat0];
            var c = rho / R;
            var lat = Math.asin(Math.cos(c) * Math.sin(phi0) + ys * Math.sin(c) * Math.cos(phi0) / rho);
            var lon = lon0 * D + Math.atan2(xs * Math.sin(c), rho * Math.cos(phi0) * Math.cos(c) - ys * Math.sin(phi0) * Math.sin(c));
            return [lon / D, lat / D];
        };
    }

    function triangleHeight(a,b,c,d,tx,ty) {
        return tx+ty<=1 ? a+(b-a)*tx+(c-a)*ty : d+(c-d)*(1-tx)+(b-d)*(1-ty);
    }
    function buildScene(host, d) {
        var W0 = d.bounds_m[2] - d.bounds_m[0], H0 = d.bounds_m[3] - d.bounds_m[1];
        var cx = (d.bounds_m[0] + d.bounds_m[2]) / 2, cy = (d.bounds_m[1] + d.bounds_m[3]) / 2;
        var maxDim = Math.max(W0, H0), pad = maxDim * 0.03 + 50;
        var W = W0 + 2 * pad, H = H0 + 2 * pad;
        // контуры в координатах сцены (центр bbox = 0,0)
        var polys = d.polygons_m.map(function (p) { return p.map(function (r) { return r.map(function (q) { return [q[0] - cx, q[1] - cy]; }); }); });
        var hfn0 = makeHeightFn(d.code);
        var hfn = function (x, y) { return hfn0(x + cx, y + cy); };
        // v20: почвенный покров и микрорельеф (карточка «Вид», настройки запоминаются)
        var gPrefs = {}; try { gPrefs = JSON.parse(localStorage.getItem('forest3d_ground_v20') || '{}') || {}; } catch (_) {}

        var renderer = new T.WebGLRenderer({ antialias: true, alpha: true, logarithmicDepthBuffer: true, preserveDrawingBuffer: false });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(host.clientWidth, host.clientHeight);
        renderer.outputColorSpace = T.SRGBColorSpace;
        host.appendChild(renderer.domElement);

        var scene = new T.Scene();
        var camera = new T.PerspectiveCamera(45, host.clientWidth / Math.max(1, host.clientHeight), 0.5, maxDim * 30);
        scene.add(new T.HemisphereLight(0xdfefff, 0x4a5a3a, 1.15));
        var sun = new T.DirectionalLight(0xfff3dd, 1.6);
        sun.position.set(-maxDim * 0.6, maxDim * 0.8, maxDim * 0.5);
        scene.add(sun);

        // ── поверхность ──
        var segX = Math.max(48, Math.round(384 * W / Math.max(W, H))), segY = Math.max(48, Math.round(384 * H / Math.max(W, H)));
        var geo = new T.PlaneGeometry(W, H, segX, segY);
        geo.rotateX(-Math.PI / 2);                     // (x, y) → (x, 0, -y): x — восток, -z — север
        var pos = geo.attributes.position, nV = pos.count;
        var baseH = new Float32Array(nV), hmin = Infinity, hmax = -Infinity, i;
        for (i = 0; i < nV; i++) { var hh = hfn(pos.getX(i), -pos.getZ(i)); baseH[i] = hh; if (hh < hmin) hmin = hh; if (hh > hmax) hmax = hh; }
        var colors = new Float32Array(nV * 3), col = new T.Color();
        var stops = [[0, new T.Color('#397337')], [0.35, new T.Color('#4b873e')], [0.6, new T.Color('#629a47')], [0.82, new T.Color('#79a955')], [1, new T.Color('#91b863')]];
        for (i = 0; i < nV; i++) {
            var t = (baseH[i] - hmin) / Math.max(1e-6, hmax - hmin), k = 1;
            while (k < stops.length - 1 && t > stops[k][0]) k++;
            var a = stops[k - 1], b = stops[k];
            col.copy(a[1]).lerp(b[1], Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0]))));
            colors[i * 3] = col.r; colors[i * 3 + 1] = col.g; colors[i * 3 + 2] = col.b;
        }
        geo.setAttribute('color', new T.BufferAttribute(colors, 3));
        // v20: геометрический микрорельеф — плавные повышения и понижения ±0,5…3 м (визуально, не данные высот);
        // длины волн не короче 4 ячеек сетки, мельче — неровности почвы в шейдере (forest3d-ground.js)
        var cellM = Math.max(W / segX, H / segY), microH = new Float32Array(nV);
        (function () {
            var sd = 0, s = String(d.code) + ':micro';
            for (var q = 0; q < s.length; q++) sd = (sd * 31 + s.charCodeAt(q)) | 0;
            var pn = makePerlin(sd ^ 0x2c1b3c6d), oct = [[640, 1], [280, 0.6], [130, 0.36], [60, 0.2], [28, 0.11]].filter(function (o) { return o[0] >= 4 * cellM; });
            if (!oct.length) return;
            var nn = 0; oct.forEach(function (o) { nn += o[1] * o[1]; }); nn = 2 / Math.sqrt(nn);
            for (var j = 0; j < nV; j++) {
                var x = pos.getX(j) + cx, y = -pos.getZ(j) + cy, h = 0;
                for (var k = 0; k < oct.length; k++) h += pn(x / oct[k][0] + k * 5.3, y / oct[k][0] - k * 3.7) * oct[k][1];
                microH[j] = h * nn;
            }
        })();

        // маска контура (alphaMap) — поверхность только внутри границы лесхоза
        var cw = 2048, ch = Math.max(256, Math.round(2048 * H / W));
        if (ch > 2048) { cw = Math.max(256, Math.round(2048 * W / H)); ch = 2048; }
        var cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
        var g2 = cv.getContext('2d');
        g2.fillStyle = '#000'; g2.fillRect(0, 0, cw, ch); g2.fillStyle = '#fff';
        g2.beginPath();
        polys.forEach(function (p) { p.forEach(function (r) { r.forEach(function (q, j) { var px = (q[0] + W / 2) / W * cw, py = (H / 2 - q[1]) / H * ch; if (j) g2.lineTo(px, py); else g2.moveTo(px, py); }); g2.closePath(); }); });
        g2.fill('evenodd');
        var mapMaskCanvas=document.createElement('canvas');mapMaskCanvas.width=cw;mapMaskCanvas.height=ch;mapMaskCanvas.getContext('2d').drawImage(cv,0,0);
        var mask = new T.CanvasTexture(cv);
        mask.anisotropy = 4;
        var terrainMat = new T.MeshStandardMaterial({ vertexColors: true, alphaMap: mask, alphaTest: 0.5, roughness: 0.95, metalness: 0, side: T.DoubleSide });
        var ground = window.Forest3DGround ? window.Forest3DGround.create({ THREE: T, origin: [cx, cy], enabled: gPrefs.soil !== false }) : null;
        if (ground) { ground.patch(terrainMat); ground.ensureAttr(geo); }
        var terrain = new T.Mesh(geo, terrainMat);
        scene.add(terrain);

        // ── срез (стенки) и дно ──
        var depth = Math.max(0.25,Math.min(8,maxDim*0.002));  // thin visual soil cut, not a raised 40 m slab
        var cell = Math.max(W / segX, H / segY);
        var rings = []; polys.forEach(function (p) { p.forEach(function (r) { rings.push(densify(r, cell)); }); });
        var nWall = 0; rings.forEach(function (r) { nWall += r.length; });
        var wallPos = new Float32Array(nWall * 2 * 3), wallCol = new Float32Array(nWall * 2 * 3), wallIdx = [], off = 0;
        var cTop = new T.Color('#6b4b2c'), cBot = new T.Color('#3b2a1a');
        rings.forEach(function (r) {
            for (var j = 0; j < r.length; j++) {
                var v = (off + j) * 2;
                wallPos[v * 3] = r[j][0]; wallPos[v * 3 + 2] = -r[j][1];
                wallPos[v * 3 + 3] = r[j][0]; wallPos[v * 3 + 4] = -depth; wallPos[v * 3 + 5] = -r[j][1];
                wallCol.set([cTop.r, cTop.g, cTop.b, cBot.r, cBot.g, cBot.b], v * 3);
                if (j < r.length - 1) wallIdx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
            }
            off += r.length;
        });
        var wallGeo = new T.BufferGeometry();
        wallGeo.setAttribute('position', new T.BufferAttribute(wallPos, 3));
        wallGeo.setAttribute('color', new T.BufferAttribute(wallCol, 3));
        wallGeo.setIndex(wallIdx);
        var walls = new T.Mesh(wallGeo, new T.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: T.DoubleSide }));
        scene.add(walls);

        var bottomGeo = new T.ShapeGeometry(polys.map(function (p) {
            var sh = new T.Shape(p[0].map(function (q) { return new T.Vector2(q[0], q[1]); }));
            for (var h = 1; h < p.length; h++) sh.holes.push(new T.Path(p[h].map(function (q) { return new T.Vector2(q[0], q[1]); })));
            return sh;
        }));
        bottomGeo.rotateX(-Math.PI / 2);
        bottomGeo.translate(0, -depth, 0);
        var bottomMesh=new T.Mesh(bottomGeo, new T.MeshStandardMaterial({ color: 0x2f2216, roughness: 1, side: T.DoubleSide }));
        bottomMesh.userData.forestBottom=true;scene.add(bottomMesh);

        // граница (жёлтая линия)
        var linePos = new Float32Array(nWall * 3), off2 = 0, lineGeo = new T.BufferGeometry(), lineGroup = new T.Group();
        lineGeo.setAttribute('position', new T.BufferAttribute(linePos, 3));
        var lineMat = new T.LineBasicMaterial({ color: 0xffd54a });
        // отдельные линии на кольцо (общий буфер, разные диапазоны)
        rings.forEach(function (r) {
            var g = new T.BufferGeometry();
            g.setAttribute('position', lineGeo.attributes.position);
            g.setDrawRange(off2, r.length);
            lineGroup.add(new T.Line(g, lineMat));
            off2 += r.length;
        });
        scene.add(lineGroup);

        // v19: названия лесничеств — через Forest3DLabels: позиция каждый кадр (без дрожания), раскладка без наложений
        var forestryEngine=window.Forest3DLabels?window.Forest3DLabels.create({THREE:T,container:host,camera:function(){return camera;},className:'v3d-forestry-labels',label:'Названия лесничеств',zIndex:1,maxShown:160,pad:4,keepBonus:1e7}):null;
        var labelsEnabled=true,forestryLabelVersion=-1;
        var labelItems=(d.forestries&&d.forestries.length)?d.forestries:(d.parent_code?[{code:d.code,name:d.name,polygons_m:d.polygons_m}]:[]);
        labelItems=labelItems.concat(d.forestry_unknown_labels||[]);
        labelItems.forEach(function(ln,idx){
            var local=(ln.polygons_m||[]).map(function(p){return p.map(function(r){return r.map(function(q){return[q[0]-cx,q[1]-cy];});});});
            var point=forestryLabelAnchor(local);if(!point||!forestryEngine)return;
            var unknown=!ln.code || !String(ln.name||'').trim() || /нет данных лесничества/i.test(ln.name||'');
            var ar=0;local.forEach(function(p){if(p[0])ar+=Math.abs(ringArea(p[0]));});
            forestryEngine.upsert('forestry|'+(ln.code||'u'+idx),{x:point[0],y:0,z:-point[1],px:point[0],py:point[1],text:unknown?'н/инф':ln.name,
                cls:'v3d-forestry-label',title:unknown?'Нет информации о лесничестве':ln.name,prio:(unknown?0:1e6)+Math.min(9e5,ar/1e4),
                style:unknown?'border-color:#ffc66b;color:#ffe1a9':'',data:{forestryCode:ln.code||'unknown'},charW:6.6,padX:16,h:22});
        });
        function updateForestryLabels(force){
            if(!forestryEngine)return;
            if(forestryLabelVersion!==reliefVersion){forestryLabelVersion=reliefVersion;forestryEngine.updateY(function(it){return groundY(it.px,it.py)+Math.max(0.3,maxDim/10000);});}
            forestryEngine.frame(performance.now(),force);
        }
        var forestryGroup = new T.Group(), forestryLines = [];
        (d.forestries || []).forEach(function (ln) {
            (ln.polygons_m || []).forEach(function (p) { p.forEach(function (r) {
                var rr = densify(r.map(function (q) { return [q[0]-cx,q[1]-cy]; }), Math.max(20, cell/2));
                var g = new T.BufferGeometry();
                g.setAttribute('position', new T.Float32BufferAttribute(new Float32Array(rr.length*3),3));
                var l = new T.Line(g, new T.LineBasicMaterial({color:0x70ddff,depthTest:false,transparent:true,opacity:0.88}));
                l.renderOrder = 8; l.userData.forestryName = ln.name;
                forestryGroup.add(l); forestryLines.push({line:l,ring:rr});
            }); });
        });
        // The common external forestry outline uses the SAME sampled ring as the forest.
        if((d.forestries||[]).length){rings.forEach(function(rr){
            var g=new T.BufferGeometry();g.setAttribute('position',new T.Float32BufferAttribute(new Float32Array(rr.length*3),3));
            var l=new T.Line(g,new T.LineBasicMaterial({color:0x70ddff,depthTest:false,transparent:true,opacity:0.88}));
            l.renderOrder=8;forestryGroup.add(l);forestryLines.push({line:l,ring:rr,outer:true});
        });}
        (d.forestry_uncovered_polygons_m||[]).forEach(function(p){p.forEach(function(r){
            var rr=densify(r.map(function(q){return[q[0]-cx,q[1]-cy];}),Math.max(20,cell/2));
            var g=new T.BufferGeometry();g.setAttribute('position',new T.Float32BufferAttribute(new Float32Array(rr.length*3),3));
            var l=new T.Line(g,new T.LineBasicMaterial({color:0xffc66b,depthTest:false,transparent:true,opacity:0.7}));
            l.renderOrder=7;forestryGroup.add(l);forestryLines.push({line:l,ring:rr});
        });});
        scene.add(forestryGroup);
        var lasGround = {}, datum = null, dem = null;
        // сетка-основание (шаг в км), чуть ниже дна
        var step = niceStep(maxDim / 8);
        var gx0 = Math.floor(-W / 2 / step) * step, gx1 = Math.ceil(W / 2 / step) * step;
        var gy0 = Math.floor(-H / 2 / step) * step, gy1 = Math.ceil(H / 2 / step) * step;
        var gp = [], gy = -depth - 1, x, y;
        for (x = gx0; x <= gx1 + 1e-6; x += step) gp.push(x, gy, -gy0, x, gy, -gy1);
        for (y = gy0; y <= gy1 + 1e-6; y += step) gp.push(gx0, gy, -y, gx1, gy, -y);
        var gridGeo = new T.BufferGeometry(); gridGeo.setAttribute('position', new T.Float32BufferAttribute(gp, 3));
        scene.add(new T.LineSegments(gridGeo, new T.LineBasicMaterial({ color: 0x36505e, transparent: true, opacity: 0.55 })));
        var basePlane = new T.Mesh(new T.PlaneGeometry(gx1 - gx0, gy1 - gy0).rotateX(-Math.PI / 2),
            new T.MeshBasicMaterial({ color: 0x9fb7c4, transparent: true, opacity: 0.35, depthWrite: false }));
        basePlane.position.set((gx0 + gx1) / 2, gy - 0.5, -(gy0 + gy1) / 2);
        scene.add(basePlane);

        // ── применение вертикального масштаба ──
        var state = { exag: 0.3, demExag: 8, relief: true, synthetic: false, micro: gPrefs.micro !== false, microAmp: Math.max(0.25, Math.min(3, +gPrefs.amp || 1)) };
        var soilKey = '', demGen = 0;
        // атрибуты почвы (относительная высота, влажность по форме рельефа) — по ЦМР / условным холмам и микрорельефу
        function updateSoil() {
            if (!ground) return;
            var mic = state.micro ? state.microAmp : 0, src = dem ? dem.values : (state.synthetic ? baseH : null), vals = new Float32Array(nV);
            for (var q = 0; q < nV; q++) vals[q] = (src ? src[q] : 0) + microH[q] * mic;
            ground.setGrid(geo, vals, segX + 1, segY + 1, cellM, 170);
        }
        var parr = pos.array, disposed = false, reliefPending = 0, reliefVersion = 0, maskKey = '', yLo = 0, yHi = 0;
        function lasMaskKey() { var k = ''; for (var id in lasGround) k += id + (lasGround[id].mesh.visible ? '+' : '-') + ';'; return k; }
        // Маска контура перерисовывается (и заново грузится в видеопамять, 2048²) только при смене набора/видимости LAS-грунта,
        // а не на каждый шаг ползунка усиления — раньше это был главный источник «заморозки».
        function redrawMask() {
            g2.fillStyle='#000';g2.fillRect(0,0,cw,ch);g2.fillStyle='#fff';g2.beginPath();
            polys.forEach(function(p){p.forEach(function(r){r.forEach(function(q,j){var px=(q[0]+W/2)/W*cw,py=(H/2-q[1])/H*ch;if(j)g2.lineTo(px,py);else g2.moveTo(px,py);});g2.closePath();});});
            g2.fill('evenodd');g2.fillStyle='#000';
            for (var id in lasGround) if (lasGround[id].maskBase) lasGround[id].maskBase(g2,W,H,cw,ch,cx,cy);
            mask.needsUpdate=true;
        }
        function applyRelief() {
            if (disposed) return;
            if (reliefPending) { cancelAnimationFrame(reliefPending); reliefPending = 0; }
            reliefVersion++;
            var j, lowest=0, highest=0, reference=datum===null?(dem?dem.info.datum:0):datum;
            var useDem=state.relief&&!!dem, useSyn=state.relief&&!dem&&state.synthetic, dv=dem?dem.values:null, ex=state.demExag, sx=state.exag, mic=state.relief&&state.micro?state.microAmp:0;
            for(j=0;j<nV;j++){
                var height=(useDem?(dv[j]-reference)*ex:useSyn?hfn(parr[j*3],-parr[j*3+2])*sx:0)+(mic?microH[j]*mic:0);
                parr[j*3+1]=height;if(height<lowest)lowest=height;if(height>highest)highest=height;
            }
            if(state.relief)for(var lk in lasGround){var layer=lasGround[lk];if(layer.mesh.visible&&Number.isFinite(layer.minZ)){lowest=Math.min(lowest,layer.minZ-reference);if(Number.isFinite(layer.maxZ))highest=Math.max(highest,layer.maxZ-reference);}}
            yLo=lowest;yHi=highest;
            var bottom=lowest-depth,gridPositions=gridGeo.attributes.position;
            bottomMesh.position.y=lowest;
            for(var gi=0;gi<gridPositions.count;gi++)gridPositions.setY(gi,bottom-1);
            gridPositions.needsUpdate=true;gridGeo.computeBoundingSphere();basePlane.position.y=bottom-1.5;
            pos.needsUpdate = true;
            var sk=(dem?'d'+demGen:state.synthetic?'s':'f')+'|'+(state.micro?state.microAmp:0);if(sk!==soilKey){soilKey=sk;updateSoil();}
            geo.computeVertexNormals();
            geo.computeBoundingSphere(); geo.computeBoundingBox();
            var o = 0;
            rings.forEach(function (r) {
                for (var q = 0; q < r.length; q++) {
                    var top = groundY(r[q][0], r[q][1]);
                    wallPos[(o + q) * 6 + 1] = top;wallPos[(o+q)*6+4]=bottom;
                    linePos[(o + q) * 3] = r[q][0]; linePos[(o + q) * 3 + 1] = top + Math.max(1.5, maxDim / 8000); linePos[(o + q) * 3 + 2] = -r[q][1];
                }
                o += r.length;
            });
            wallGeo.attributes.position.needsUpdate = true; wallGeo.computeVertexNormals(); wallGeo.computeBoundingSphere();
            lineGeo.attributes.position.needsUpdate = true;
            lineGroup.children.forEach(function (l) { l.geometry.computeBoundingSphere(); });
            forestryLines.forEach(function (f) {
                var p=f.line.geometry.attributes.position;
                f.ring.forEach(function(q,i){p.setXYZ(i,q[0],groundY(q[0],q[1])+(f.outer?Math.max(1.5,maxDim/8000):Math.max(1.8,maxDim/9000)),-q[1]);});
                p.needsUpdate=true; f.line.geometry.computeBoundingSphere();
            });
            for(var uk in lasGround)lasGround[uk].update();
            // Remove the coarse background surface ONLY under valid LAS cells.
            var mk=lasMaskKey();if(mk!==maskKey){maskKey=mk;redrawMask();}
            if(controls)followGround();
            if (api && api.onRelief) api.onRelief();
            if (api && api.requestRender) api.requestRender();
        }
        // Ползунки/переключатели: пересчёт рельефа не чаще одного раза за кадр
        function scheduleRelief() {
            if (disposed || reliefPending) return;
            reliefPending = requestAnimationFrame(function () { reliefPending = 0; applyRelief(); });
        }
        var api = null;
        function groundY(x, y, noMicro) {   // noMicro: высота данных (без визуального микрорельефа) — для измерений
            if (!state.relief) return 0;
            // for-in вместо Object.keys(): без выделения памяти — функция вызывается миллионы раз (деревья, линии, подписи)
            var surface=null;
            for(var k in lasGround){var h=lasGround[k].sample(x+cx,y+cy);if(h!==null&&(surface===null||h>surface))surface=h;}
            if(surface!==null)return surface-datum;
            // Match the coarse mesh triangles outside LAS, too.
            var fx=(x+W/2)/W*segX,fy=(H/2-y)/H*segY;
            if(!(fx>=0&&fy>=0&&fx<=segX&&fy<=segY))return !dem&&state.synthetic?hfn(x,y)*state.exag:0;
            var ix=Math.min(segX-1,Math.floor(fx)),iy=Math.min(segY-1,Math.floor(fy)),i=iy*(segX+1)+ix;
            var gh=triangleHeight(parr[i*3+1],parr[(i+1)*3+1],parr[(i+segX+1)*3+1],parr[(i+segX+2)*3+1],fx-ix,fy-iy);
            if(noMicro&&state.micro)gh-=triangleHeight(microH[i],microH[i+1],microH[i+segX+1],microH[i+segX+2],fx-ix,fy-iy)*state.microAmp;
            return gh;
        }   // x — восток, y — север (сцена)
        // v20: карта сомкнутости крон (затенённая подстилка под деревьями LAS) — общая для поверхности и грунта LAS
        var canopyLayers = [], canopyTimer = 0;
        function canopyRebuild() {
            canopyTimer = 0; if (!ground || disposed) return;
            var vis = canopyLayers.filter(function (L) { return L.n > 0 && L.isVisible(); });
            if (!vis.length) { ground.setCanopy(null); if (api && api.requestRender) api.requestRender(); return; }
            var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
            vis.forEach(function (L) { var b = L.bounds; x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]); });
            x0 -= 25; y0 -= 25; x1 += 25; y1 += 25;
            var px = Math.max(1.25, Math.max(x1 - x0, y1 - y0) / 2048), w = Math.max(2, Math.min(2048, Math.ceil((x1 - x0) / px))), h = Math.max(2, Math.min(2048, Math.ceil((y1 - y0) / px)));
            var g = new Float32Array(w * h);
            vis.forEach(function (L) {
                var a = L.arr;
                for (var k = 0; k < L.n; k += L.step) {
                    var tx = (a[k * 7] - cx - x0) / px, ty = (a[k * 7 + 1] - cy - y0) / px, R = Math.max(0.9, a[k * 7 + 4] / 2) / px, ht = a[k * 7 + 2];
                    var dens = (a[k * 7 + 6] % 10 === 1 ? 0.78 : 0.62) * Math.min(1, 0.45 + ht / 22);
                    if (R < 0.75) { var qx = Math.floor(tx), qy = Math.floor(ty); if (qx >= 0 && qy >= 0 && qx < w && qy < h) { var q0 = qy * w + qx, v0 = dens * Math.min(1, 3.14 * R * R); g[q0] = 1 - (1 - g[q0]) * (1 - v0); } continue; }
                    var ix0 = Math.max(0, Math.floor(tx - R)), ix1 = Math.min(w - 1, Math.ceil(tx + R)), iy0 = Math.max(0, Math.floor(ty - R)), iy1 = Math.min(h - 1, Math.ceil(ty + R)), iR2 = 1 / (R * R);
                    for (var yy = iy0; yy <= iy1; yy++) for (var xx = ix0; xx <= ix1; xx++) {
                        var ddx = xx + 0.5 - tx, ddy = yy + 0.5 - ty, dd = (ddx * ddx + ddy * ddy) * iR2; if (dd >= 1) continue;
                        var q = yy * w + xx, vv = dens * (1 - dd); g[q] = 1 - (1 - g[q]) * (1 - vv);
                    }
                }
            });
            var b2 = new Float32Array(w * h);   // сглаживание 3×3
            for (var yy2 = 0; yy2 < h; yy2++) for (var xx2 = 0; xx2 < w; xx2++) {
                var sum = 0, cnt = 0;
                for (var oy = -1; oy <= 1; oy++) { var ry = yy2 + oy; if (ry < 0 || ry >= h) continue; for (var ox = -1; ox <= 1; ox++) { var rx = xx2 + ox; if (rx < 0 || rx >= w) continue; sum += g[ry * w + rx]; cnt++; } }
                b2[yy2 * w + xx2] = sum / cnt;
            }
            ground.setCanopy(b2, w, h, [x0, y0, x0 + w * px, y0 + h * px]);
            if (api && api.requestRender) api.requestRender();
        }
        function canopyDirty() { if (!ground || disposed) return; if (canopyTimer) clearTimeout(canopyTimer); canopyTimer = setTimeout(canopyRebuild, 250); }
        // Пересечение луча с поверхностью по карте высот: отсечение по охвату и диапазону высот,
        // шаг ~0,6 ячейки сетки + бисекция. Раньше — raycast по ~300 тыс. треугольников на каждое движение мыши.
        function rayGround(r, maxDist) {
            var o=r.origin,d=r.direction,t0=0,t1=Math.min(maxDist||Infinity,maxDim*40);
            function slab(oc,dc,lo,hi){
                if(Math.abs(dc)<1e-12)return oc>=lo&&oc<=hi;
                var ta=(lo-oc)/dc,tb=(hi-oc)/dc;if(ta>tb){var tmp=ta;ta=tb;tb=tmp;}
                if(ta>t0)t0=ta;if(tb<t1)t1=tb;return t0<=t1;
            }
            if(!slab(o.x,d.x,-W/2,W/2)||!slab(o.z,d.z,-H/2,H/2)||!slab(o.y,d.y,yLo-1,yHi+1))return null;
            function f(t){return o.y+d.y*t-groundY(o.x+d.x*t,-(o.z+d.z*t));}
            var fp=f(t0);
            if(fp<=0)return {distance:t0,point:{x:o.x+d.x*t0,y:o.y+d.y*t0,z:o.z+d.z*t0}};
            var step=Math.max(0.25,cell*0.6),n=Math.min(8000,Math.ceil((t1-t0)/step)),tp=t0;
            for(var si=1;si<=n;si++){
                var t=si===n?t1:t0+si*step,ft=f(t);
                if(ft<=0){
                    var lo=tp,hi=t;
                    for(var it=0;it<22;it++){var mid=(lo+hi)/2;if(f(mid)>0)lo=mid;else hi=mid;}
                    var th=(lo+hi)/2;
                    return {distance:th,point:{x:o.x+d.x*th,y:o.y+d.y*th,z:o.z+d.z*th}};
                }
                tp=t;
            }
            return null;
        }
        applyRelief();

        // ── камера и управление ──
        var controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true; controls.dampingFactor = 0.08;
        controls.minDistance = 4;
        controls.maxDistance = maxDim * 6;
        controls.maxPolarAngle = Math.PI * 0.495;
        controls.screenSpacePanning = false;
        var correctingCamera=false;
        function followGround(){
            if(!controls||correctingCamera)return;correctingCamera=true;
            var targetY=groundY(controls.target.x,-controls.target.z),dy=targetY-controls.target.y;
            controls.target.y=targetY;camera.position.y+=dy;
            var minY=groundY(camera.position.x,-camera.position.z)+1.5;
            if(camera.position.y<minY)camera.position.y=minY;
            correctingCamera=false;
        }
        controls.addEventListener('change',followGround);
        function resetView() {
            var dist = maxDim * 1.25,targetY=groundY(0,0);
            camera.position.set(0,targetY+dist*Math.cos(0.95),dist*Math.sin(0.95));
            controls.target.set(0,targetY,0);controls.update();
        }
        resetView();

        api = {
            renderer: renderer, scene: scene, camera: camera, controls: controls, terrain: terrain,
            state: state, applyRelief: applyRelief, resetView: resetView, polys: polys, cx: cx, cy: cy,
            baseGeometry:geo, mapMaskCanvas:mapMaskCanvas,
            ground:ground, microH:microH, updateSoil:updateSoil,
            canopyAdd:function(L){canopyLayers.push(L);canopyDirty();},
            canopyRemove:function(L){var k=canopyLayers.indexOf(L);if(k>=0){canopyLayers.splice(k,1);canopyDirty();}},
            canopyDirty:canopyDirty,
            lasGround:lasGround, forestryGroup:forestryGroup,
            updateForestryLabels:updateForestryLabels,
            setForestryLabels:function(on){labelsEnabled=!!on;if(forestryEngine)forestryEngine.setEnabled(labelsEnabled);updateForestryLabels(true);},
            setDatum:function(z){if(datum===null){datum=z;state.demExag=1;scheduleRelief();}return datum;},
            scheduleRelief:scheduleRelief, rayGround:rayGround, requestRender:null,
            markDisposed:function(){disposed=true;if(reliefPending){cancelAnimationFrame(reliefPending);reliefPending=0;}if(canopyTimer){clearTimeout(canopyTimer);canopyTimer=0;}if(ground)ground.dispose();},
            isDisposed:function(){return disposed;},
            getReliefVersion:function(){return reliefVersion;},
            hasLASDatum:function(){return datum!==null;},
            getDatum:function(){return datum===null?(dem?dem.info.datum:0):datum;},
            hasDEM:function(){return !!dem;},
            getDEMInfo:function(){return dem?dem.info:null;},
            setDEM:function(values,info){
                if(values.length!==nV)throw new Error('ЦМР: неверный размер сетки');
                dem={values:values,info:info};demGen++;state.synthetic=false;if(datum!==null)state.demExag=1;var legacy=host.querySelector('[data-r=synthetic]');if(legacy){legacy.checked=false;legacy.disabled=true;}var oldRange=host.querySelector('#v3d-tools input[type=range]');if(oldRange)oldRange.disabled=true;
                for(var v=0;v<nV;v++){
                    var t=(values[v]-info.min)/Math.max(.01,info.max-info.min),k=1;while(k<stops.length-1&&t>stops[k][0])k++;
                    var a=stops[k-1],b=stops[k];col.copy(a[1]).lerp(b[1],Math.max(0,Math.min(1,(t-a[0])/(b[0]-a[0]))));colors[v*3]=col.r;colors[v*3+1]=col.g;colors[v*3+2]=col.b;
                }
                geo.attributes.color.needsUpdate=true;applyRelief();
                if(api.onDEM)api.onDEM(info);
            },
            gridStep: step, depth: depth, hrange: [hmin, hmax], groundY: groundY, maxDim: maxDim, onRelief: null
        };
        return api;
    }

    /* Дешёвая «подпись» состояния сцены: позиции/видимость объектов, версии геометрии, материалов и текстур, камера.
       Если подпись не изменилась — кадр не перерисовывается (рендер по требованию, без нагрузки GPU в простое). */
    function matSig(m) {
        var s = m.id * 3 + m.version * 67 + (m.opacity || 0) * 71 + (m.visible === false ? 7 : 0);
        if (m.map) s += m.map.id * 5 + m.map.version * 73;
        if (m.alphaMap) s += m.alphaMap.id * 11 + m.alphaMap.version * 79;
        if (m.color) s += m.color.r * 83 + m.color.g * 89 + m.color.b * 97;
        return s;
    }
    function sceneSignature(sc) {
        var s = 0, n = 0;
        sc.scene.traverseVisible(function (o) {
            n++;
            var p = o.position, q = o.quaternion, k = o.scale, w = (n % 29) + 1;
            s += (p.x + 2 * p.y + 3 * p.z + 5 * q.x + 7 * q.y + 11 * q.z + 13 * q.w + 17 * k.x + 19 * k.y + 23 * k.z + o.id * 0.001) * w;
            var g = o.geometry;
            if (g) {
                s += g.id * 31 * w;
                var at = g.attributes;
                for (var key in at) s += at[key].version * 37 * w;
                if (g.index) s += g.index.version * 41;
                var dr = g.drawRange; s += dr.start * 43 + (dr.count === Infinity ? 0 : dr.count * 47);
            }
            if (o.isInstancedMesh) s += o.count * 53 + o.instanceMatrix.version * 59 + (o.instanceColor ? o.instanceColor.version * 61 : 0);
            var m = o.material;
            if (m) { if (Array.isArray(m)) { for (var i = 0; i < m.length; i++) s += matSig(m[i]) * w; } else s += matSig(m) * w; }
        });
        var c = sc.camera, cp = c.position, cq = c.quaternion;
        return s + n * 1e7 + cp.x * 101 + cp.y * 103 + cp.z * 107 + cq.x * 109 + cq.y * 113 + cq.z * 127 + cq.w * 131 + c.fov * 137 + c.aspect * 139;
    }

    /* ───────────────────────── окно 3D ───────────────────────── */
    function compassSVG() {
        return '<svg viewBox="-24 -24 48 48"><circle r="22" fill="rgba(0,0,0,.25)" stroke="rgba(255,255,255,.35)"/>' +
            '<path d="M0-19 L6 0 L0-3 L-6 0Z" fill="#ff5a4a"/><path d="M0 19 L6 0 L0 3 L-6 0Z" fill="#e8f5e9"/>' +
            '<text y="-9" x="0" fill="#fff" font-size="7" font-weight="800" text-anchor="middle" font-family="Arial" transform="translate(0,-4)">С</text></svg>';
    }
    function csrf() { var m = document.querySelector('meta[name="csrf-token"]'); return m ? m.content : ''; }

    /* Видимая часть карты: пересечение с окном браузера минус боковая панель лесхозов слева.
       (Раньше окно 3D растягивалось на весь #map и уходило под панель/за край экрана.) */
    function visibleRect() {
        var map = getMap(), vw = window.innerWidth, vh = window.innerHeight;
        var t = map ? map.getTargetElement().getBoundingClientRect() : { left: 0, top: 0, right: vw, bottom: vh };
        var L = Math.max(0, t.left), Tp = Math.max(0, t.top), R = Math.min(vw, t.right), B = Math.min(vh, t.bottom);
        if (document.body.classList.contains('fullscreen-mode')) return { L: 0, T: 0, R: vw, B: vh };
        var cands = document.querySelectorAll('.sidebar, #sidebar, .leshoz-sidebar, #lsp-panel');
        for (var i = 0; i < cands.length; i++) {
            var el = cands[i], cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
            var r = el.getBoundingClientRect();
            if (r.width < 8 || r.height < (B - Tp) * 0.5) continue;
            if (r.left <= L + 8 && r.right > L && r.right < L + (R - L) * 0.6) L = r.right;
        }
        if (R - L < 320) L = Math.max(0, R - 320);
        if (B - Tp < 300) Tp = Math.max(0, B - 300);
        return { L: L, T: Tp, R: R, B: B };
    }
    function fitOverlay(v) {
        if (!v || !v.ov) return;
        var r = visibleRect(), key = [r.L, r.T, r.R, r.B].map(Math.round).join(',');
        if (key === v.rectKey) return;
        v.rectKey = key;
        var s = v.ov.style;
        s.left = r.L + 'px'; s.top = r.T + 'px'; s.width = (r.R - r.L) + 'px'; s.height = (r.B - r.T) + 'px';
    }

    var droneScriptPromise=null;
    function loadDroneModule(){
        if(window.ForestDrone&&window.BuselModel)return Promise.resolve();
        if(droneScriptPromise)return droneScriptPromise;
        function script(url,ready){return new Promise(function(resolve,reject){if(ready()){resolve();return;}var s=document.createElement('script');s.src=url;s.onload=function(){if(ready())resolve();else reject(new Error('Модуль БПЛА не инициализирован: '+url));};s.onerror=function(){reject(new Error('Не загружен '+url));};document.head.appendChild(s);});}
        droneScriptPromise=script('/static/busel_model.js?v=busel-native-v2-gear',function(){return !!window.BuselModel;}).then(function(){return script('/static/forest_uav_types.js?v=uav-v19',function(){return !!window.ForestUAV;}).catch(function(e){console.warn('Типы БПЛА не загружены — доступен только «Бусел»:',e&&e.message);});}).then(function(){return script('/static/forest_drone.js?v=uav-sim-v19',function(){return !!window.ForestDrone;});}).catch(function(e){droneScriptPromise=null;throw e;});
        return droneScriptPromise;
    }
    function openViewer(code) {
        if(!accessState || !accessState.allowed){refreshAccess().then(function(a){if(a.allowed)openViewer(code);else toast('3D доступен только администратору',true);});return;}
        var map = getMap();
        if (!map) return;
        injectCSS();
        if (viewer) closeViewer(false);
        stopPick();
        var ov = document.createElement('div');
        ov.id = 'v3d-overlay';
        ov.innerHTML = '<div id="v3d-loading"><i class="fa-solid fa-cube fa-spin"></i>Строю 3D-модель лесхоза…</div>';
        document.body.appendChild(ov);
        ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'click', 'dblclick', 'contextmenu', 'keydown', 'touchstart', 'touchmove'].forEach(function (ev) {
            ov.addEventListener(ev, function (e) { e.stopPropagation(); if (ev === 'contextmenu') e.preventDefault(); }, { passive: ev !== 'contextmenu' });
        });
        var v = viewer = { code: code, ov: ov, alive: true, raf: 0, ro: null, data: null, sc: null, clouds: {}, timers: [] };
        fitOverlay(v);
        v.fitTimer = setInterval(function () { if (!document.hidden) fitOverlay(v); }, 600);
        v.onResize = function () { fitOverlay(v); };
        window.addEventListener('resize', v.onResize);
        setBtnState();
        document.addEventListener('keydown', onKey, true);
        Promise.all([loadThree(), getJSON(API + '/item/' + encodeURIComponent(code)), getList().catch(function () { return null; }),loadDroneModule().catch(function(e){toast(e.message,true);return null;})]).then(function (res) {
            if (!v.alive) return;
            var d = res[1]; v.data = d;
            if (!hasWebGL()) throw new Error('Браузер не поддерживает WebGL — 3D недоступно');
            ov.innerHTML = '';
            var sc = v.sc = buildScene(ov, d);
            // реалистичные деревья: модели грузятся параллельно с остальными данными сцены (один раз за сеанс)
            if (window.Forest3DTrees && treesQuality() === 'real') {
                try {
                    var caps3 = sc.renderer.capabilities;
                    window.Forest3DTrees.load(T, { anisotropy: Math.min(4, caps3.getMaxAnisotropy ? caps3.getMaxAnisotropy() : 1) }).catch(function (e) { console.warn('Деревья 3D:', e && e.message); });
                } catch (_) {}
            }
            sc.onRelief = function () { if(v.mapLayers)v.mapLayers.updateGround();if(v.dem)v.dem.sync();if(v.tax)v.tax.updateGround(); Object.keys(v.clouds).forEach(function (k) { var st=v.clouds[k];if(st.layer)st.layer.update();if(st.points)st.points.update(); }); };
            buildHUD(v, d, sc);
            if(window.Forest3DMapLayers) {
                v.mapLayers=window.Forest3DMapLayers.create({THREE:T,scene:sc,data:d,host:v.left,isAlive:function(){return v.alive;}});
            } else {toast('Для кварталов и выделов скопируйте static/forest3d-map-layers.js из обновления.',true);}
            if(window.Forest3DTerrain){v.dem=window.Forest3DTerrain.create({THREE:T,scene:sc,data:d,host:v.left,isAlive:function(){return v.alive;}});}
            else{toast('Модуль реальной ЦМР не загружен: static/forest3d-terrain.js',true);}
            var stationPoint=forestryLabelAnchor(sc.polys)||[0,0];
            if(window.ForestDrone&&window.BuselModel){v.drone=window.ForestDrone.create({THREE:T,scene:sc,host:ov,data:d,home:{x:stationPoint[0],z:-stationPoint[1]},
                inside:function(x,y){return pointInRings(x,y,sc.polys);},
                areas:function(){return Object.keys(v.clouds).map(function(k){return v.clouds[k];}).filter(function(c){return c.visible&&c.layer&&c.layer.bounds;}).map(function(c){var b=c.layer.bounds;return {minX:b[0],minY:b[1],maxX:b[2],maxY:b[3]};});},
                status:function(text){var el=ov.querySelector('.v3d-drone-status');if(el)el.textContent=text;},
                collision:function(from,to,heading,bank,broken,halfSpan){
                    var dir=new T.Vector3(to.x-from.x,to.y-from.y,to.z-from.z),distance=dir.length();
                    if(distance<0.001)return false;dir.normalize();var sideways=new T.Vector3(Math.cos(heading),0,Math.sin(heading));
                    var layers=Object.keys(v.clouds).map(function(k){return v.clouds[k];}).filter(function(c){return c.visible&&c.layer;});
                    var hs=(halfSpan||1.55)/1.55,probes=[0,-.5,.5,-.85,.85,-1.2,1.2,-1.55,1.55].map(function(o){return o*hs;});
                    for(var i=0;i<probes.length;i++){var offset=probes[i],side=offset<0?'left':'right';if(offset&&broken&&broken.includes(side))continue;
                        var origin=new T.Vector3(from.x,from.y-Math.sin(bank)*offset,from.z).addScaledVector(sideways,offset).addScaledVector(dir,-.35);
                        if(layers.some(function(c){return !!c.layer.pick(new T.Ray(origin,dir),distance+.7,{1:true,2:true});}))return {part:offset?'wing':'body',side:side,reason:offset?'касание крылом кроны LAS':'удар фюзеляжем о крону LAS'};
                    }return false;
                }});
            ov.querySelector('[data-drone=enter]').onclick=function(){v.drone.enter();};}else{ov.querySelector('[data-drone=enter]').disabled=true;ov.querySelector('.v3d-drone-status').textContent='Для режима БПЛА скопируйте static/forest_drone.js, static/forest_uav_types.js и static/busel_model.js из обновления.';}
            v.ro = new ResizeObserver(function () {
                var w = ov.clientWidth, h = ov.clientHeight;
                if (!w || !h) return;
                sc.renderer.setSize(w, h); sc.camera.aspect = w / h; sc.camera.updateProjectionMatrix();
                if (v.kick) v.kick();
            });
            v.ro.observe(ov);
            var comp = ov.querySelector('#v3d-compass svg'), compRot = '';
            // ── потеря/восстановление WebGL-контекста (нехватка видеопамяти, сбой/обновление драйвера) ──
            var lostMsg = document.createElement('div');
            lostMsg.id = 'v3d-ctxlost'; lostMsg.setAttribute('role', 'alert'); lostMsg.style.display = 'none';
            lostMsg.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i><div><b>3D-сцена временно недоступна</b><br>Видеокарта сбросила WebGL-контекст (нехватка видеопамяти или сбой драйвера). Восстанавливаю сцену…</div><button type="button" data-ctx="reopen">Перезапустить 3D</button>';
            ov.appendChild(lostMsg);
            lostMsg.querySelector('[data-ctx=reopen]').onclick = function () { var c = v.code; closeViewer(false); openViewer(c); };
            var cvs = sc.renderer.domElement;
            v.onCtxLost = function (e) {
                e.preventDefault(); v.ctxLost = true; lostMsg.style.display = ''; lostMsg.classList.remove('stuck');
                clearTimeout(v.ctxT); v.ctxT = setTimeout(function () { if (v.alive && v.ctxLost) lostMsg.classList.add('stuck'); }, 6000);
            };
            v.onCtxRestored = function () {
                v.ctxLost = false; clearTimeout(v.ctxT); lostMsg.classList.remove('stuck'); lostMsg.style.display = 'none';
                v.lastSig = NaN; if (v.kick) v.kick(800);
            };
            cvs.addEventListener('webglcontextlost', v.onCtxLost, false);
            cvs.addEventListener('webglcontextrestored', v.onCtxRestored, false);
            // ── рендер по требованию: кадр рисуется только при изменении камеры, сцены, анимации или в полёте Бусла ──
            v.lastSig = NaN; v.renderUntil = 0; v.frames = 0;
            v.kick = function (ms) { var t = performance.now() + (ms || 400); if (t > v.renderUntil) v.renderUntil = t; };
            sc.requestRender = v.kick;
            ['pointerdown', 'pointerup', 'wheel', 'keydown', 'input', 'change', 'click'].forEach(function (ev) {
                ov.addEventListener(ev, function () { v.kick(); }, { passive: true, capture: true });
            });
            (function loop(now) {
                if (!v.alive) return;
                v.raf = requestAnimationFrame(loop);
                now = now || performance.now();
                if (v.ctxLost) return;
                var need = now < v.renderUntil;
                if (sc.anim) {
                    var a = sc.anim, k = Math.min(1, (now - a.t0) / a.dur), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
                    sc.controls.target.lerpVectors(a.fromT, a.toT, e);
                    sc.camera.position.lerpVectors(a.fromP, a.toP, e);
                    if (k >= 1) sc.anim = null;
                    need = true;
                }
                if (sc.controls.enabled && sc.controls.update()) need = true;
                var flying = !!(v.drone && v.drone.active);
                if (v.drone) v.drone.tick(now);
                if (flying) need = true;
                for (var ck in v.clouds) if (v.clouds[ck].layer) v.clouds[ck].layer.lod(sc.camera);
                if (v.tax) v.tax.lod();
                if (comp) {
                    var rot = 'rotate(' + (flying ? -v.drone.state.heading * 180 / Math.PI : sc.controls.getAzimuthalAngle() * 180 / Math.PI).toFixed(1) + 'deg)';
                    if (rot !== compRot) { compRot = rot; comp.style.transform = rot; }
                }
                // подпись снимается ПОСЛЕ рендера: three.js сам повышает версию прозрачных двусторонних материалов при отрисовке
                if (!need && sceneSignature(sc) !== v.lastSig) need = true;
                if (need) { sc.renderer.render(sc.scene, sc.camera); v.lastSig = sceneSignature(sc); v.frames++; }
                sc.updateForestryLabels();
                if (v.mapLayers && v.mapLayers.tick) v.mapLayers.tick(now);
                if (v.drone) v.drone.postRender(now);
            })();
            loadClouds(v, true);
        }).catch(function (e) {
            // Ответ устаревшего запроса (пользователь уже открыл другой лесхоз или закрыл 3D) не должен закрывать новую сцену
            if (viewer !== v) return;
            toast('3D: ' + (e && e.message ? e.message : e), true);
            closeViewer(false);
        });
    }

    function flyTo(sc, x, z, dist) {
        var y = sc.groundY(x, -z);
        var toT = new T.Vector3(x, y, z);
        var off = sc.camera.position.clone().sub(sc.controls.target);
        if (off.lengthSq() < 1) off.set(0, 1, 1);
        off.normalize();
        if (off.y < 0.35) { off.y = 0.55; off.normalize(); }
        sc.anim = { t0: performance.now(), dur: 1300, fromT: sc.controls.target.clone(), fromP: sc.camera.position.clone(),
            toT: toT, toP: toT.clone().add(off.multiplyScalar(dist)) };
    }

    function card(id, icon, title, open) {
        var c = document.createElement('div');
        c.className = 'v3d-card' + (open ? '' : ' collapsed');
        c.id = id;
        c.innerHTML = '<h4><i class="fa-solid ' + icon + '"></i>' + title + '<i class="fa-solid fa-chevron-down"></i></h4><div class="v3d-body"></div>';
        c.querySelector('h4').addEventListener('click', function () { c.classList.toggle('collapsed'); });
        return c;
    }

    function buildHUD(v, d, sc) {
        var ov = v.ov;
        var left = document.createElement('div');
        left.id = 'v3d-left';
        ov.appendChild(left);
        v.left = left;
        // свернуть/развернуть всю панель — чтобы она не закрывала модель на небольших экранах
        var tg = document.createElement('button');
        tg.type = 'button'; tg.id = 'v3d-toggle'; tg.className = 'v3d-card v3d-abs';
        tg.innerHTML = '<i class="fa-solid fa-angles-left"></i>';
        tg.title = 'Скрыть панель';
        tg.addEventListener('click', function () {
            var hid = left.style.display !== 'none';
            left.style.display = hid ? 'none' : '';
            tg.classList.toggle('hid', hid);
            tg.innerHTML = hid ? '<i class="fa-solid fa-angles-right"></i> Панель' : '<i class="fa-solid fa-angles-left"></i>';
            tg.title = hid ? 'Показать панель' : 'Скрыть панель';
        });
        ov.appendChild(tg);
        if (window.innerWidth - (ov.getBoundingClientRect().left || 0) < 700) setTimeout(function () { tg.click(); }, 0);
        buildAccessCard(v,left);
        var droneCard=card('v3d-drone','fa-plane','БПЛА · полёт и съёмка',true);
        droneCard.querySelector('.v3d-body').innerHTML='<button type="button" class="fd-launch" data-drone="enter">Режим БПЛА — войти</button><div class="note v3d-drone-status">Бусел, Геоскан 201, WingtraOne, DJI M350 + L2, Mavic 3E / 3M (ТТХ ориентировочные). Миссии «змейкой» с автопилотом, приборы, мини-карта, геймпад. Скорость в м/с, время 1:1.</div>';
        left.appendChild(droneCard);
        // ── лесхоз ──
        var mean = d.mean_area_km2, cmp = '';
        if (mean) { var r = d.area_km2 / mean; cmp = Math.abs(r - 1) < 0.05 ? 'примерно как в среднем по лесхозам' : r >= 1 ? ('в ' + fmt(r, 1) + ' раза больше среднего') : ('в ' + fmt(1 / r, 1) + ' раза меньше среднего'); }
        var kmW = d.size_m[0] / 1000, kmH = d.size_m[1] / 1000;
        var info = card('v3d-info', 'fa-tree', esc(d.name), window.innerHeight >= 950);
        info.querySelector('h4').style.fontSize = '15px';
        var forestCode=d.parent_code||d.code;
        var forestSelect=document.createElement('select');
        forestSelect.setAttribute('data-forest','select');forestSelect.setAttribute('aria-label','Выберите лесхоз');
        forestSelect.style.cssText='flex:1;min-width:0;max-width:100%;font-weight:700;font-size:14px';
        var initial=document.createElement('option');initial.value=forestCode;initial.textContent=d.parent_name||d.name;forestSelect.appendChild(initial);
        var heading=info.querySelector('h4');
        heading.innerHTML='<i class="fa-solid fa-tree"></i><i class="fa-solid fa-chevron-down"></i>';
        heading.insertBefore(forestSelect,heading.lastElementChild);
        ['click','pointerdown','keydown'].forEach(function(ev){forestSelect.addEventListener(ev,function(e){e.stopPropagation();});});
        forestSelect.onchange=function(){if(this.value!==forestCode)openViewer(this.value);else if(v.code!==forestCode)openViewer(forestCode);};
        getList().then(function(rows){
            if(!v.alive)return;
            var forests=rows.filter(function(row){return !row.kind||row.kind==='forest';});
            forests.sort(function(a,b){return a.name.localeCompare(b.name,'ru');});
            forestSelect.innerHTML='';
            forests.forEach(function(row){var opt=document.createElement('option');opt.value=row.code;opt.textContent=row.name;opt.selected=row.code===forestCode;forestSelect.appendChild(opt);});
            if(!forests.some(function(row){return row.code===forestCode;})){forestSelect.appendChild(initial);initial.selected=true;}
        }).catch(function(){toast('Не удалось загрузить список лесхозов',true);});
        info.querySelector('.v3d-body').innerHTML = '<div class="sub" style="margin-bottom:6px">Код ' + esc(d.code) + ' · 3D-модель местности · ' + esc(d.crs) + '</div><table>' +
            '<tr><td>Площадь</td><td><b>' + fmt(d.area_ha, 1) + ' га</b> (' + fmt(d.area_km2, 2) + ' км²)</td></tr>' +
            '<tr><td>Периметр</td><td>' + fmt(d.perimeter_km, 1) + ' км</td></tr>' +
            '<tr><td>Размер</td><td>' + fmt(kmW, 1) + ' × ' + fmt(kmH, 1) + ' км (З–В × Ю–С)</td></tr>' +
            '<tr><td>Центр</td><td>' + d.center[1].toFixed(5) + '° с.ш., ' + d.center[0].toFixed(5) + '° в.д.</td></tr>' +
            '<tr><td>Охват</td><td>' + d.bbox_wgs84[1].toFixed(3) + '…' + d.bbox_wgs84[3].toFixed(3) + '° с.ш.<br>' + d.bbox_wgs84[0].toFixed(3) + '…' + d.bbox_wgs84[2].toFixed(3) + '° в.д.</td></tr>' +
            (d.rank ? '<tr><td>По площади</td><td>' + d.rank + '-й из ' + d.count + (cmp ? '<br><span style="color:#a8c3a8">' + cmp + '</span>' : '') + '</td></tr>' : '') +
            '</table>';
        left.appendChild(info);

        var fc=card('v3d-forestry','fa-draw-polygon','Лесничества',true), fbody=fc.querySelector('.v3d-body');
        var choices=d.forestries||d.siblings||[];
        fbody.innerHTML=(d.parent_code?'<div class="sub">'+esc(d.parent_name)+'</div>':'')+
            '<div class="row"><label><input type="checkbox" data-ln="lines" checked> Границы лесничеств (голубые)</label></div>'+
            '<div class="row"><label><input type="checkbox" data-ln="labels" checked> Названия лесничеств на карте</label></div>'+
            '<div class="row"><select data-ln="select" aria-label="Лесничество" style="max-width:100%"><option value="" disabled'+(d.parent_code?'':' selected')+'>Выберите лесничество</option><option value="'+esc(d.parent_code||d.code)+'">Все лесничества лесхоза</option>'+
            choices.map(function(ln){return '<option value="'+esc(ln.code)+'"'+(ln.code===d.code?' selected':'')+'>'+esc(ln.name)+' · '+fmt(ln.area_ha,1)+' га</option>';}).join('')+'</select></div>'+
            '<div class="note">Жёлтый контур — выбранная территория; голубые линии — внутренние лесничества. Выберите лесничество для отдельной 3D-сцены и обрезки LAS по его границе.</div>';
        if(d.forestry_uncovered_area_ha>1){
            var warn=document.createElement('div');warn.className='note';warn.style.color='#ffcf8a';
            warn.textContent='В SHP лесничеств нет покрытия для '+fmt(d.forestry_uncovered_area_ha,1)+' га ('+fmt(d.forestry_uncovered_percent,1)+'%). Эти участки отмечены оранжевым как «н/инф», без изменения привязки LAS.';
            fbody.appendChild(warn);
        }
        fbody.querySelector('[data-ln=lines]').onchange=function(){sc.forestryGroup.visible=this.checked;};
        fbody.querySelector('[data-ln=labels]').onchange=function(){sc.setForestryLabels(this.checked);};
        fbody.querySelector('[data-ln=select]').onchange=function(){if(this.value&&this.value!==v.code)openViewer(this.value);};
        left.appendChild(fc);
        // ── облака точек ──
        var lc = card('v3d-las', 'fa-braille', 'Облака точек LAS/LAZ → деревья', true);
        lc.querySelector('.v3d-body').innerHTML =
            '<div class="row" style="margin-top:0"><span class="lg" style="background:#2f7a3d"></span>хвойные <button type="button" data-f="1" class="on">показ</button>' +
            '<span class="lg" style="background:#8cc63f;margin-left:6px"></span>лиственные <button type="button" data-f="2" class="on">показ</button></div>' +
            '<div class="v3d-clouds"><div class="sub">Загрузка списка…</div></div>' +
            '<div class="v3d-stats"></div>' +
            '<div class="v3d-up"></div>';
        left.appendChild(lc);
        v.lasCard = lc;
        v.filter = { 1: true, 2: true };
        lc.querySelectorAll('button[data-f]').forEach(function (b) {
            b.addEventListener('click', function () {
                var t = +b.getAttribute('data-f');
                v.filter[t] = !v.filter[t];
                b.classList.toggle('on', v.filter[t]);
                b.textContent = v.filter[t] ? 'показ' : 'скрыто';
                Object.keys(v.clouds).forEach(function (k) { var c = v.clouds[k]; if (c.layer) c.layer.setVisible(c.visible, v.filter); });
                renderStats(v);
            });
        });
        buildUpload(v);
        // [v20.11] MDB обрабатываются локально в браузере; отдельные данные не загружаются на сервер.
        if(window.Forest3DTaxation){
            try { v.tax=window.Forest3DTaxation.attach({THREE:T,sc:sc,data:d,host:left,card:card,
                fly:function(x,z,dist){flyTo(sc,x,z,dist);}}); }
            catch(e){console.error('Таксация 3D:',e);toast('Таксация 3D: '+e.message,true);}
        }
        // ── v19: ЛесоЛидар — обработки LAS этой сцены (деревья по породам, рельеф LAS, результаты) ──
        if (window.LesoLidarWeb) {
            try {
                v.ll = window.LesoLidarWeb.attach({
                    THREE: T, sc: sc, data: d, code: v.code, name: d.name, host: left, after: lc, card: card, toast: toast,
                    isAlive: function () { return v.alive; },
                    target: function () { var t = sc.controls.target; return [t.x + sc.cx, -t.z + sc.cy]; },
                    groundZ: function (x, y) { if (!sc.state.relief || !sc.hasDEM()) return undefined; return sc.getDatum() + sc.groundY(x - sc.cx, y - sc.cy, true) / (sc.state.demExag || 1); },
                    fly: function (id) { var st = v.clouds[id], L = st && st.layer; if (L && L.n) flyTo(sc, L.center[0], -L.center[1], Math.max(120, L.size * 1.1)); },
                    addTrees: function (id, arr, meta, opts) {
                        var st = v.clouds[id];
                        if (st && st.layer) { try { st.layer.dispose(); } catch (_) {} }
                        if (!st) st = v.clouds[id] = { meta: meta, visible: true, layer: null, ll: true };
                        st.meta = meta; st.visible = true; st.layer = TreeLayer(sc, arr, opts);
                        st.layer.setVisible(true, v.filter); renderStats(v); if (v.kick) v.kick();
                        return { n: st.layer.n, center: st.layer.center, size: st.layer.size };
                    },
                    recolor: function (id, colors, mode) { var st = v.clouds[id]; if (st && st.layer && st.layer.recolor) { st.layer.recolor(colors, mode); if (v.kick) v.kick(); } },
                    setTreesVisible: function (id, vis) { var st = v.clouds[id]; if (!st) return; st.visible = !!vis; if (st.layer) st.layer.setVisible(st.visible, v.filter); renderStats(v); if (v.kick) v.kick(); },
                    removeTrees: function (id) { var st = v.clouds[id]; if (!st) return; try { if (st.layer) st.layer.dispose(); if (st.terrain) st.terrain.dispose(); } catch (_) {} delete v.clouds[id]; renderStats(v); },
                    hasTerrain: function (id) { var st = v.clouds[id]; return !!(st && st.terrain); },
                    addTerrain: function (id, grid) {
                        var st = v.clouds[id] || (v.clouds[id] = { meta: null, visible: true, layer: null, ll: true });
                        if (st.terrain) { try { st.terrain.dispose(); } catch (_) {} }
                        st.terrain = TerrainLayer(sc, id, grid); st.terrain.mesh.visible = true; sc.scheduleRelief();
                    },
                    setTerrainVisible: function (id, vis) { var st = v.clouds[id]; if (st && st.terrain) { st.terrain.mesh.visible = !!vis; sc.scheduleRelief(); } }
                });
            } catch (e) { console.warn('ЛесоЛидар в 3D:', e); }
        }

        // ── вид ──
        var tools = card('v3d-tools', 'fa-sliders', 'Вид', true);
        tools.querySelector('.v3d-body').innerHTML =
            '<div class="row" style="margin-top:0"><label>Рельеф:</label><button type="button" data-r="1" class="on">ЦМР / LAS</button><button type="button" data-r="0">плоский</button></div>' +
            '<div class="row"><label><input type="checkbox" data-r="synthetic"> Условные холмы без ЦМР (не реальные высоты)</label></div>'+
            '<div class="row"><label>Условные холмы ×<b class="v3d-ex">' + sc.state.exag + '</b></label><input type="range" min="0.1" max="2" step="0.1" value="' + sc.state.exag + '"></div>' +
            '<div class="row v3d-ground"><label title="Цвет поверхности по почвенному покрову: хвойная подстилка, мох, трава, сухая трава, песок и лишайник на сухих грядах, торф в понижениях, затенение под кронами"><input type="checkbox" data-g="soil"' + (!sc.ground || sc.ground.enabled() ? ' checked' : '') + '> Почвенный покров (подстилка, мох, трава, песок, торф)</label></div>' +
            '<div class="row v3d-ground"><label title="Плавные повышения и понижения поверхности и неровности почвы — только для наглядности, высоты данных и измерения не меняются"><input type="checkbox" data-g="micro"' + (sc.state.micro ? ' checked' : '') + '> Микрорельеф ±<b class="v3d-mamp">' + String(sc.state.microAmp).replace('.', ',') + '</b> м (визуально)</label><input type="range" data-g="amp" min="0.25" max="3" step="0.25" value="' + sc.state.microAmp + '"' + (sc.state.micro ? '' : ' disabled') + '></div>' +
            '<div class="row v3d-tq"><label>Деревья:</label><button type="button" data-tq="real" title="3D-модели по породам: вблизи — полные (ветви, листва, хвоя), вдали — упрощённые изображения тех же моделей">реалистичные</button><button type="button" data-tq="simple" title="Схематичные кроны (конус/шар) — быстрее на слабых видеокартах">простые</button><span class="v3d-tq-st"></span></div>' +
            '<div class="row"><button type="button" data-a="reset"><i class="fa-solid fa-rotate-left"></i> Сбросить вид</button>' +
            '<button type="button" data-a="top"><i class="fa-solid fa-arrows-down-to-line"></i> Сверху</button>' +
            '<button type="button" data-a="other"><i class="fa-solid fa-list"></i> Выбрать лесничество</button>' +
            '<button type="button" data-a="close" class="close"><i class="fa-solid fa-map"></i> Закрыть (2D)</button></div>' +
            '<div class="note">В пределах загруженного LAS грунт строится по ЦМР облака, в метрах, без преувеличения. Вне LAS загружается открытая ЦМР Terrarium. Вертикальное усиление ЦМР задаётся в отдельной карточке; исходные высоты остаются в метрах. Если источник недоступен, ошибка показана явно. Случайные холмы по умолчанию не подставляются. Высоты LAS без преувеличения. Поверхность зелёная; ярко-зелёные участки с LAS-точками у грунта — культуры по вашему правилу. Срез грунта коричневый. Деревья: «реалистичные» — 3D-модели по породам (вблизи полные, вдали упрощённые изображения тех же моделей), размер по высоте и диаметру кроны из LAS; «простые» — схематичные кроны. Исходные параметры LAS не изменяются. Высота 0 м не удаляется и сама по себе не доказывает наличие саженца.</div>';
        left.appendChild(tools);
        var rng = tools.querySelector('input[type=range]'), exl = tools.querySelector('.v3d-ex');
        var tqRow = tools.querySelector('.v3d-tq'), tqSt = tools.querySelector('.v3d-tq-st');
        function tqSync() {
            var F = window.Forest3DTrees, q = treesQuality();
            tqRow.querySelectorAll('button[data-tq]').forEach(function (x) { x.classList.toggle('on', x.getAttribute('data-tq') === q); });
            tqSt.textContent = !F || q !== 'real' ? '' : F.error() ? 'модели не загрузились — показаны простые' : F.loading() ? 'загрузка моделей…' : '';
        }
        if (!window.Forest3DTrees) tqRow.style.display = 'none';
        tqRow.addEventListener('click', function (e) {
            var b = e.target.closest('button[data-tq]'), F = window.Forest3DTrees; if (!b || !F) return;
            F.quality(b.getAttribute('data-tq'));
            var go = function () {
                if (!v.alive) return;
                var q = treesQuality();
                Object.keys(v.clouds).forEach(function (k) { var L = v.clouds[k].layer; if (L && L.setQuality) L.setQuality(q); });
                tqSync();
            };
            if (treesQuality() === 'real' && !F.lib()) F.load(T).then(go, function () { if (v.alive) tqSync(); });
            go();
        });
        tqSync();
        if (window.Forest3DTrees && window.Forest3DTrees.loading()) window.Forest3DTrees.load(T).then(tqSync, tqSync);
        // v20: почвенный покров и микрорельеф
        var gSoil = tools.querySelector('[data-g=soil]'), gMicro = tools.querySelector('[data-g=micro]'), gAmp = tools.querySelector('[data-g=amp]'), gAmpL = tools.querySelector('.v3d-mamp');
        function gSave() { try { localStorage.setItem('forest3d_ground_v20', JSON.stringify({ soil: !sc.ground || sc.ground.enabled(), micro: sc.state.micro, amp: sc.state.microAmp })); } catch (_) {} }
        if (!sc.ground) gSoil.closest('.row').style.display = 'none';
        gSoil.onchange = function () { if (!sc.ground) return; sc.ground.setEnabled(this.checked); if (v.dem && v.dem.refreshLegend) v.dem.refreshLegend(); if (sc.requestRender) sc.requestRender(); gSave(); };
        gMicro.onchange = function () { sc.state.micro = this.checked; gAmp.disabled = !this.checked; sc.scheduleRelief(); gSave(); };
        gAmp.addEventListener('input', function () { sc.state.microAmp = +gAmp.value; gAmpL.textContent = String(+gAmp.value).replace('.', ','); if (sc.state.micro) sc.scheduleRelief(); gSave(); });
        tools.querySelector('[data-r=synthetic]').onchange=function(){sc.state.synthetic=this.checked;rng.disabled=!this.checked||!sc.state.relief;sc.scheduleRelief();};
        rng.disabled=true;
        rng.addEventListener('input', function () { sc.state.exag = +rng.value; exl.textContent = rng.value; if (sc.state.relief) sc.scheduleRelief(); });
        tools.querySelectorAll('button[data-r]').forEach(function (b) {
            b.addEventListener('click', function () {
                sc.state.relief = b.getAttribute('data-r') === '1';
                tools.querySelectorAll('button[data-r]').forEach(function (x) { x.classList.toggle('on', x === b); });
                rng.disabled = !sc.state.relief || !sc.state.synthetic;
                sc.scheduleRelief();
            });
        });
        tools.addEventListener('click', function (e) {
            var b = e.target.closest('button[data-a]'); if (!b) return;
            var a = b.getAttribute('data-a');
            if (a === 'reset') { sc.anim = null; sc.resetView(); }
            else if (a === 'top') {
                sc.anim = null;
                var dist = sc.camera.position.distanceTo(sc.controls.target);
                sc.camera.position.set(sc.controls.target.x, sc.controls.target.y + dist, sc.controls.target.z + dist * 0.001);
                sc.controls.update();
            }
            else if (a === 'other') { fc.classList.remove('collapsed');fbody.querySelector('[data-ln=select]').focus();fc.scrollIntoView({block:'nearest',behavior:'smooth'}); }
            else if (a === 'close') closeViewer(true);
        });

        var comp = document.createElement('div');
        comp.id = 'v3d-compass'; comp.className = 'v3d-card v3d-abs'; comp.title = 'Север вверх (сбросить вид)';
        comp.innerHTML = compassSVG();
        comp.addEventListener('click', function () { sc.anim = null; sc.resetView(); });
        ov.appendChild(comp);

        var scl = document.createElement('div');
        scl.id = 'v3d-scale'; scl.className = 'v3d-card v3d-abs';
        scl.textContent = 'Сетка: ' + (sc.gridStep >= 1000 ? fmt(sc.gridStep / 1000) + ' км' : fmt(sc.gridStep) + ' м');
        ov.appendChild(scl);

        var help = document.createElement('div');
        help.id = 'v3d-help'; help.className = 'v3d-card v3d-abs';
        help.textContent = 'ЛКМ — вращать · ПКМ — сдвигать · колесо — масштаб · Esc — 2D';
        ov.appendChild(help);

        var co = document.createElement('div');
        co.id = 'v3d-coords'; co.className = 'v3d-card v3d-abs';
        co.textContent = 'Наведите курсор на модель';
        ov.appendChild(co);

        var inv = makeInverse(d.center[0], d.center[1]);
        v.inv = inv;
        var ray = new T.Raycaster(), ndc = new T.Vector2(), pend = false, lastEv = null;
        var hl = new T.Mesh(new T.CylinderGeometry(1, 1, 1, 16, 1, true).translate(0, 0.5, 0),
            new T.MeshBasicMaterial({ color: 0xffd54a, wireframe: true, transparent: true, opacity: 0.9, depthTest: false }));
        hl.visible = false; hl.renderOrder = 10;
        sc.scene.add(hl);
        var downXY = null;
        sc.renderer.domElement.addEventListener('pointerdown', function (e) { downXY = [e.clientX, e.clientY]; });
        sc.renderer.domElement.addEventListener('pointerup', function (e) {
            if (!downXY || Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]) > 4) return;
            var rect = sc.renderer.domElement.getBoundingClientRect();
            ndc.set((e.clientX - rect.left) / rect.width * 2 - 1, -(e.clientY - rect.top) / rect.height * 2 + 1);
            ray.setFromCamera(ndc, sc.camera);
            for (var k in v.clouds) {
                var L = v.clouds[k].layer;
                if (L && L.marker.visible && ray.intersectObject(L.marker, true).length) {
                    flyTo(sc, L.center[0], -L.center[1], Math.max(120, L.size * 1.1));
                    return;
                }
            }
        });
        sc.renderer.domElement.addEventListener('pointerleave', function () {
            lastEv = null; if (hl.visible) hl.visible = false; co.textContent = 'Наведите курсор на модель';
        });
        sc.renderer.domElement.addEventListener('pointermove', function (e) {
            if(v.drone&&v.drone.active)return;
            lastEv = e;
            if (pend) return; pend = true;
            requestAnimationFrame(function () {
                pend = false;
                if (!v.alive || !lastEv) return;
                var rect = sc.renderer.domElement.getBoundingClientRect();
                ndc.set((lastEv.clientX - rect.left) / rect.width * 2 - 1, -(lastEv.clientY - rect.top) / rect.height * 2 + 1);
                ray.setFromCamera(ndc, sc.camera);
                // LAS-грунт имеет приоритет (как в groundY); без перебора всех треугольников поверхности
                var hit = sc.rayGround(ray.ray);
                var tHit = hit ? hit.distance : Infinity, best = null;
                Object.keys(v.clouds).forEach(function (k) {
                    var c = v.clouds[k];
                    if (!c.layer || !c.visible) return;
                    var p = c.layer.pick(ray.ray, Math.min(tHit + 1, 1e12), v.filter);
                    if (p && (!best || p.t < best.t)) best = p;
                });
                if (best) {
                    var tr = best.tree, ll = inv(tr.x + sc.cx, tr.y + sc.cy);
                    hl.visible = true;
                    hl.position.set(tr.x, tr.base, -tr.y);
                    hl.scale.set(Math.max(0.6, tr.cd / 2) * 1.08, tr.h * 1.03, Math.max(0.6, tr.cd / 2) * 1.08);
                    co.innerHTML = '<b>' + (tr.typ === 1 ? '🌲 ' : '🌳 ') + esc(tr.sp || (tr.typ === 1 ? 'Хвойное' : 'Лиственное')) + '</b> · высота <b>' + fmt(tr.h, 1) + ' м</b> · Ø ствола <b>' +
                        fmt(tr.dbh, 0) + ' см</b> <span style="color:#a8c3a8">(' + (tr.meas ? 'измерен' : 'оценка') + ')</span> · Ø кроны ' + fmt(tr.cd, 1) +
                        ' м · крона с ' + fmt(tr.cbh, 1) + ' м · ' + ll[1].toFixed(6) + '°, ' + ll[0].toFixed(6) + '°' + (tr.src ? ' · <span style="color:#a8c3a8">' + esc(tr.src) + '</span>' : '');
                    return;
                }
                hl.visible = false;
                if (!hit) { co.textContent = 'Наведите курсор на модель'; return; }
                var ex = hit.point.x, ny = -hit.point.z;
                if (!sc.polys.length || !pointInRings(ex, ny, sc.polys)) { co.textContent = 'Вне границы лесхоза'; return; }
                var ll2 = inv(ex + sc.cx, ny + sc.cy);
                co.innerHTML = 'WGS-84: <b>' + ll2[1].toFixed(5) + '° с.ш., ' + ll2[0].toFixed(5) + '° в.д.</b>';
            });
        });
    }

    /* ───────────────────────── деревья (InstancedMesh) ───────────────────────── */
    var MAX_TREES = 600000;   // сколько деревьев рисовать в браузере (статистика — по всем)
    function coniferGeometry(low) {
        var rows=low?12:28,segments=low?8:20,profile=[];
        profile.push(new T.Vector2(0,0));
        for(var i=1;i<rows;i++){
            var y=i/rows;
            var radius=Math.pow(1-y,0.88)*(0.80+0.20*Math.min(1,y/0.12));
            radius*=1+0.045*Math.sin(y*Math.PI*16)*(1-y);
            profile.push(new T.Vector2(radius,y));
        }
        profile.push(new T.Vector2(0,1));
        var g=new T.LatheGeometry(profile,segments),pos=g.attributes.position;
        for(var i=0;i<pos.count;i++){
            var y=pos.getY(i),a=Math.atan2(pos.getZ(i),pos.getX(i));
            var f=1+0.065*Math.sin(a*5+y*19)+0.025*Math.sin(a*9-y*31);
            pos.setX(i,pos.getX(i)*f);pos.setZ(i,pos.getZ(i)*f);
        }
        var foliage=new Float32Array(pos.count*3);
        for(var i=0;i<pos.count;i++){
            var y=pos.getY(i),a=Math.atan2(pos.getZ(i),pos.getX(i));
            var shade=0.88+0.10*Math.sin(a*7+y*51)*Math.sin(a*3-y*37)+0.07*y;
            foliage[i*3]=shade*0.96;foliage[i*3+1]=shade;foliage[i*3+2]=shade*0.93;
        }
        g.setAttribute('color',new T.BufferAttribute(foliage,3));
        g.computeVertexNormals();return g;
    }
    // Качество деревьев: 'real' — реалистичные модели (forest3d-trees.js), 'simple' — схематичные кроны
    function treesQuality() {
        var F = window.Forest3DTrees;
        return F && F.quality() === 'real' ? 'real' : 'simple';
    }
    function TreeLayer(sc, arr, opts) {
        opts = opts || {};
        var spArr = opts.species || null, spNames = opts.names || null, spColors = opts.colors || null, colorMode = opts.colorMode || 'natural', colCache = {};
        var n = arr.length / 7, step = 1;
        if(!n)return {n:0,center:[0,0],size:60,update:function(){},setVisible:function(){},pick:function(){return null;},dispose:function(){},lod:function(){},recolor:function(){},setQuality:function(){},quality:function(){return 'none';},stats:function(){return null;}};
        if (n > MAX_TREES) step = Math.ceil(n / MAX_TREES);
        var i, alive = true, curVis = true, curFilter = { 1: true, 2: true }, quality = 'simple', want = treesQuality();
        var SL = null;     // схематичные кроны (конусы/шары)
        var RL = null;     // реалистичные модели (Forest3DTrees)
        var shadeTo = new T.Color(0x1d3322);
        function buildSimple() {
            if (SL) return;
            var idx = { 1: [], 2: [] }, j;
            for (j = 0; j < n; j += step) idx[(arr[j * 7 + 6] % 10) === 1 ? 1 : 2].push(j);
            var L = { group: new T.Group(), parts: {} };
            L.geoTrunk = new T.CylinderGeometry(0.22, 1, 1, 12, 3, false).translate(0, 0.5, 0);
            L.geoCone = coniferGeometry(false); L.geoConeLow = coniferGeometry(true);
            L.geoBall = new T.IcosahedronGeometry(1, 2);
            L.matTrunk = new T.MeshStandardMaterial({ color: 0x66513a, roughness: 1 });
            var leafColors=new Float32Array(L.geoBall.attributes.position.count*3);leafColors.fill(1);
            L.geoBall.setAttribute('color',new T.BufferAttribute(leafColors,3));
            L.matCrown = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92,vertexColors:true });
            [1, 2].forEach(function (t) {
                var cnt = idx[t].length;
                if (!cnt) return;
                var tr = new T.InstancedMesh(L.geoTrunk, L.matTrunk, cnt);
                var cr = new T.InstancedMesh(t === 1 ? L.geoConeLow : L.geoBall, L.matCrown, cnt);
                tr.frustumCulled = cr.frustumCulled = false;
                L.group.add(tr); L.group.add(cr);
                L.parts[t] = { trunk: tr, crown: cr, ids: idx[t] };
            });
            SL = L;
            paintSimple(); placeSimple();
            sc.scene.add(L.group);
        }
        function disposeSimple() {
            if (!SL) return;
            sc.scene.remove(SL.group);
            [SL.geoTrunk, SL.geoCone, SL.geoConeLow, SL.geoBall, SL.matTrunk, SL.matCrown].forEach(function (o) { o.dispose(); });
            SL.group.children.forEach(function (m) { if (m.dispose) m.dispose(); });
            SL = null;
        }
        function paintSimple() {   // цвет крон: по типу (хвойные/лиственные) или по породе (ЛесоЛидар: натуральный/легенда)
            if (!SL) return;
            [1, 2].forEach(function (t) {
                var p = SL.parts[t]; if (!p) return;
                var col = new T.Color(), base = new T.Color(t === 1 ? 0x3f7448 : 0x719947), dark = new T.Color(t === 1 ? 0x294b35 : 0x4e7538);
                for (var j = 0; j < p.ids.length; j++) {
                    var k = p.ids[j], hh = arr[k * 7 + 2], jit = ((k * 2654435761 >>> 0) % 100);
                    var f = Math.min(1, Math.max(0, (hh - 5) / 25));
                    if (spArr && spColors && spColors[spArr[k]]) {
                        var sid = spArr[k], sb = colCache[sid] || (colCache[sid] = new T.Color(spColors[sid]));
                        col.copy(sb).lerp(shadeTo, 0.06 + f * 0.22 + jit / 900);
                    } else col.copy(base).lerp(dark, f * 0.8 + jit / 500);
                    p.crown.setColorAt(j, col);
                }
                p.crown.instanceColor.needsUpdate = true;
            });
        }
        // сетка для подбора под курсором и выбора ближних деревьев (ячейка 12 м)
        var CS = 12, grid = new Map(), minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, maxH = 0;
        for (i = 0; i < n; i += step) {
            var x = arr[i * 7] - sc.cx, y = arr[i * 7 + 1] - sc.cy;
            if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (arr[i * 7 + 2] > maxH) maxH = arr[i * 7 + 2];
            var key = Math.floor(x / CS) * 100003 + Math.floor(y / CS);
            var b = grid.get(key); if (!b) grid.set(key, b = []); b.push(i);
        }
        // контур участка облака (голубая рамка)
        var frame = new T.LineLoop(new T.BufferGeometry().setAttribute('position', new T.BufferAttribute(new Float32Array(4 * 16 * 3), 3)),
            new T.LineBasicMaterial({ color: 0x29b6f6 }));
        sc.scene.add(frame);
        // метка участка (видна издалека, постоянный экранный размер)
        var marker = new T.Group();
        var mPole = new T.Mesh(new T.CylinderGeometry(0.04, 0.04, 1, 6).translate(0, 0.5, 0), new T.MeshBasicMaterial({ color: 0x29b6f6 }));
        var mHead = new T.Mesh(new T.ConeGeometry(0.35, 0.7, 12).rotateX(Math.PI).translate(0, 1.35, 0), new T.MeshBasicMaterial({ color: 0x29b6f6 }));
        var mDot = new T.Mesh(new T.SphereGeometry(0.22, 12, 8).translate(0, 1.55, 0), new T.MeshBasicMaterial({ color: 0xffffff }));
        marker.add(mPole); marker.add(mHead); marker.add(mDot);
        marker.userData.cloudMarker = true;
        sc.scene.add(marker);
        var baseArr = new Float32Array(n);
        var m4 = new T.Matrix4();
        function placeSimple() {
            if (!SL) return;
            var j, k;
            [1, 2].forEach(function (t) {
                var p = SL.parts[t]; if (!p) return;
                for (j = 0; j < p.ids.length; j++) {
                    k = p.ids[j];
                    var x = arr[k * 7] - sc.cx, z = -(arr[k * 7 + 1] - sc.cy), h = arr[k * 7 + 2], dbh = arr[k * 7 + 3] / 100,
                        R = Math.max(0.06, Math.min(h*0.6, arr[k * 7 + 4] / 2)), cb = Math.min(arr[k * 7 + 5], h * 0.9), b0 = baseArr[k];
                    h=Math.max(0.05,h);cb=Math.max(0,Math.min(cb,h*0.90));
                    // CBH inferred by LAS is uncertain; limit extreme naked poles in the visual model only.
                    if(t===1)cb=Math.min(cb,h*0.30);
                    var radius=Math.max(0.004,dbh>0?dbh/2:Math.min(0.02,h*0.02));
                    // Sink the root just below all sides of the trunk footprint on a slope.
                    var root=Math.min(b0,sc.groundY(x-radius,-z),sc.groundY(x+radius,-z),sc.groundY(x,-z-radius),sc.groundY(x,-z+radius))-Math.min(0.08,Math.max(0.015,radius*0.15));
                    var trunkLen=(t===1?h*0.98:cb+(h-cb)*0.45)+(b0-root);
                    m4.makeScale(radius,trunkLen,radius);m4.setPosition(x,root,z);
                    p.trunk.setMatrixAt(j, m4);
                    if (t === 1) { m4.makeScale(R, h - cb, R); m4.setPosition(x, b0 + cb, z); }
                    else { m4.makeScale(R, (h - cb) / 2, R); m4.setPosition(x, b0 + (cb + h) / 2, z); }
                    // Stable per-tree rotation removes identical radial silhouettes.
                    var angle=((k*2654435761>>>0)%360)*Math.PI/180;
                    var sx=m4.elements[0],sz=m4.elements[10],ca=Math.cos(angle),sa=Math.sin(angle);
                    m4.elements[0]=sx*ca;m4.elements[2]=-sx*sa;m4.elements[8]=sz*sa;m4.elements[10]=sz*ca;
                    p.crown.setMatrixAt(j, m4);
                }
                p.trunk.instanceMatrix.needsUpdate = true; p.crown.instanceMatrix.needsUpdate = true;
            });
        }
        function update() {
            var k;
            for (k = 0; k < n; k += step) baseArr[k] = sc.groundY(arr[k * 7] - sc.cx, arr[k * 7 + 1] - sc.cy);
            placeSimple();
            if (RL) RL.update(baseArr);
            // рамка по краю участка
            var pa = frame.geometry.attributes.position.array, q = 0, s, e = 4;
            var pts = [[minX - e, minY - e], [maxX + e, minY - e], [maxX + e, maxY + e], [minX - e, maxY + e], [minX - e, minY - e]];
            for (s = 0; s < 4; s++) for (var u = 0; u < 16; u++) {
                var a0 = pts[s], a1 = pts[s + 1], tt = u / 16, xx = a0[0] + (a1[0] - a0[0]) * tt, yy = a0[1] + (a1[1] - a0[1]) * tt;
                pa[q++] = xx; pa[q++] = sc.groundY(xx, yy) + 1.5; pa[q++] = -yy;
            }
            frame.geometry.attributes.position.needsUpdate = true;
            frame.geometry.computeBoundingSphere();
            var mcx = (minX + maxX) / 2, mcy = (minY + maxY) / 2;
            marker.position.set(mcx, sc.groundY(mcx, mcy) + maxH, -mcy);
        }
        function buildReal() {
            var F = window.Forest3DTrees;
            if (RL || !F || !F.lib()) return false;
            try {
                RL = F.createLayer({ arr: arr, n: n, step: step, species: spArr, colors: spColors, colorMode: colorMode, scene: sc.scene, cx: sc.cx, cy: sc.cy,
                    ground: function (x, y) { return sc.groundY(x, y); }, grid: grid, CS: CS, requestRender: function (ms) { if (sc.requestRender) sc.requestRender(ms); } });
                RL.update(baseArr); RL.setVisible(curVis, curFilter);
                return true;
            } catch (e) { console.warn('Деревья 3D: реалистичные модели недоступны —', e); RL = null; return false; }
        }
        function applyQuality() {   // переключение представления без пересоздания слоя
            if (!alive) return;
            if (want === 'real' && buildReal()) { quality = 'real'; disposeSimple(); }
            else {
                if (RL) { RL.dispose(); RL = null; }
                buildSimple(); quality = 'simple';
                if (want === 'real' && window.Forest3DTrees && !window.Forest3DTrees.lib() && !window.Forest3DTrees.error()) {
                    window.Forest3DTrees.load(T).then(function () { if (alive && want === 'real' && !RL) { applyQuality(); if (sc.requestRender) sc.requestRender(600); } }).catch(function (e) { console.warn('Деревья 3D: модели не загружены —', e && e.message); });
                }
            }
            applyVis();
            if (sc.requestRender) sc.requestRender(400);
        }
        function setQuality(q) { want = q === 'real' ? 'real' : 'simple'; applyQuality(); }
        function lod(cam) {   // метка: постоянный размер на экране, прячется вблизи; ближние деревья — полные модели
            var dd = cam.position.distanceTo(marker.position);
            if (SL && SL.parts[1]) SL.parts[1].crown.geometry = SL.parts[1].ids.length <= 10000 && dd < Math.max(180, maxH * 12) ? SL.geoCone : SL.geoConeLow;
            if (RL) RL.lod(cam);
            marker.visible = curVis && dd > 900;
            var k = dd / 28;
            marker.scale.set(k, k, k);
        }
        function applyVis() {
            frame.visible = curVis; marker.visible = curVis;
            if (SL) { SL.group.visible = curVis; [1, 2].forEach(function (t) { if (SL.parts[t]) { SL.parts[t].trunk.visible = SL.parts[t].crown.visible = !!curFilter[t]; } }); }
            if (RL) RL.setVisible(curVis, curFilter);
        }
        function setVisible(vis, filter) { var was = curVis; curVis = !!vis; if (filter) curFilter = { 1: !!filter[1], 2: !!filter[2] }; applyVis(); if (was !== curVis && sc.canopyDirty) sc.canopyDirty(); }
        // первый показ: заранее загруженные модели → сразу реалистичные; иначе схематичные до окончания загрузки
        update();
        applyQuality();
        var canopyRef = { arr: arr, n: n, step: step, bounds: [minX, minY, maxX, maxY], isVisible: function () { return alive && curVis; } };
        if (sc.canopyAdd) sc.canopyAdd(canopyRef);
        function pick(r, tMax, filter) {
            // отрезок луча в слое деревьев: y ∈ [ymin, ymax]
            var y0 = sc.groundY((minX + maxX) / 2, (minY + maxY) / 2), yLo = y0 - 300, yHi = y0 + 300 + maxH;
            var o = r.origin, d = r.direction, t0 = 0, t1 = tMax;
            if (Math.abs(d.y) > 1e-9) {
                var ta = (yLo - o.y) / d.y, tb = (yHi - o.y) / d.y;
                t0 = Math.max(t0, Math.min(ta, tb)); t1 = Math.min(t1, Math.max(ta, tb));
            }
            if (!(t1 > t0)) return null;
            if (t1 - t0 > 20000) t1 = t0 + 20000;
            var seen = new Set(), best = null, ns = Math.min(1500, Math.ceil((t1 - t0) / (CS / 2)) + 1);
            for (var s = 0; s <= ns; s++) {
                var t = t0 + (t1 - t0) * s / ns, px = o.x + d.x * t, py = -(o.z + d.z * t);
                for (var gx = -1; gx <= 1; gx++) for (var gy = -1; gy <= 1; gy++) {
                    var key = (Math.floor(px / CS) + gx) * 100003 + Math.floor(py / CS) + gy;
                    if (seen.has(key)) continue; seen.add(key);
                    var b = grid.get(key); if (!b) continue;
                    for (var q = 0; q < b.length; q++) {
                        var k = b[q], typ = arr[k * 7 + 6] % 10 === 1 ? 1 : 2;
                        if (!filter[typ]) continue;
                        var cx = arr[k * 7] - sc.cx, cz = -(arr[k * 7 + 1] - sc.cy), R = Math.max(0.6, arr[k * 7 + 4] / 2), h = arr[k * 7 + 2];
                        var ox = o.x - cx, oz = o.z - cz, A = d.x * d.x + d.z * d.z, B = 2 * (ox * d.x + oz * d.z), C = ox * ox + oz * oz - R * R;
                        var disc = B * B - 4 * A * C; if (disc < 0 || A < 1e-12) continue;
                        var sq = Math.sqrt(disc), ti = (-B - sq) / (2 * A), to = (-B + sq) / (2 * A), base = baseArr[k];
                        var yi = o.y + d.y * ti, yo = o.y + d.y * to, tt = null;
                        if (yi >= base && yi <= base + h) tt = ti;
                        else if ((yi > base + h && yo <= base + h) && d.y < 0) tt = (base + h - o.y) / d.y;
                        if (tt !== null && tt > 0 && tt < tMax && (!best || tt < best.t))
                            best = { t: tt, tree: { x: cx, y: -cz, h: h, dbh: arr[k * 7 + 3], cd: arr[k * 7 + 4], cbh: arr[k * 7 + 5], typ: typ, meas: arr[k * 7 + 6] >= 10, base: base,
                                sp: spArr && spNames ? spNames[spArr[k]] || null : null, src: opts.source || null } };
                    }
                }
                if (best && best.t < t) break;
            }
            return best;
        }
        function dispose() {
            alive = false;
            if (sc.canopyRemove) sc.canopyRemove(canopyRef);
            disposeSimple();
            if (RL) { RL.dispose(); RL = null; }
            sc.scene.remove(frame); sc.scene.remove(marker);
            [frame.geometry, frame.material].forEach(function (o) { o.dispose(); });
            marker.children.forEach(function (m) { m.geometry.dispose(); m.material.dispose(); });
        }
        function recolor(colors, mode) {
            spColors = colors || null; if (mode) colorMode = mode; colCache = {};
            paintSimple(); if (RL) RL.recolor(spColors, colorMode);
        }
        return { update: update, setVisible: setVisible, pick: pick, dispose: dispose, step: step, n: n, lod: lod, marker: marker, recolor: recolor,
            setQuality: setQuality, quality: function () { return quality; }, stats: function () { return RL ? RL.stats() : null; },
            bounds: [minX, minY, maxX, maxY], center: [(minX + maxX) / 2, (minY + maxY) / 2], size: Math.max(maxX - minX, maxY - minY, 60) };
    }

    function TerrainLayer(sc, id, data) {
        var nx=data.nx,ny=data.ny,b=data.bounds_m,z=data.z;
        sc.setDatum(data.datum_m);
        var dx=(b[2]-b[0])/(nx-1),dy=(b[3]-b[1])/(ny-1);
        var pos=new Float32Array(nx*ny*3),colors=new Float32Array(nx*ny*3),indices=[];
        for(var y=0;y<ny;y++)for(var x=0;x<nx;x++){
            var i=y*nx+x,xx=b[0]+x*dx-sc.cx,yy=b[1]+y*dy-sc.cy;
            pos[i*3]=xx;pos[i*3+2]=-yy;
            var f=0.92+0.08*Math.sin(xx*0.17)*Math.cos(yy*0.13);
            var culture = data.cultures && data.cultures[i];
            colors.set(culture?[0.31*f,0.65*f,0.18*f]:[0.27*f,0.48*f,0.19*f],i*3);
            if(x<nx-1&&y<ny-1){
                var ids=[i,i+1,i+nx,i+nx+1];
                if(ids.every(function(k){return z[k]!==null;}))indices.push(i,i+1,i+nx,i+1,i+nx+1,i+nx);
            }
        }
        var geo=new T.BufferGeometry();geo.setAttribute('position',new T.BufferAttribute(pos,3));
        geo.setAttribute('color',new T.BufferAttribute(colors,3));geo.setIndex(indices);
        var priority=Object.keys(sc.lasGround).length+1;
        var mat=new T.MeshStandardMaterial({vertexColors:true,roughness:1,side:T.DoubleSide,polygonOffset:true,polygonOffsetFactor:-2*priority,polygonOffsetUnits:-2*priority});
        if(sc.ground){sc.ground.patch(mat);sc.ground.setGrid(geo,z,nx,ny,Math.max(dx,dy),45);}   // v20: почвенный покров и на рельефе LAS
        var mesh=new T.Mesh(geo,mat);mesh.renderOrder=priority;sc.scene.add(mesh);
        var minZ=Infinity,maxZ=-Infinity;z.forEach(function(v){if(v!==null&&Number.isFinite(v)){if(v<minZ)minZ=v;if(v>maxZ)maxZ=v;}});
        var bx0=b[0],by0=b[1],nx1=nx-1,ny1=ny-1;
        var api={mesh:mesh,minZ:minZ,maxZ:maxZ,sample:function(x,y){
            if(!mesh.visible)return null;
            var fx=(x-bx0)/dx,fy=(y-by0)/dy;
            if(!(fx>=0&&fy>=0&&fx<=nx1&&fy<=ny1))return null;
            var ix=fx>=nx1?nx-2:Math.floor(fx),iy=fy>=ny1?ny-2:Math.floor(fy),i=iy*nx+ix;
            var z0=z[i],z1=z[i+1],z2=z[i+nx],z3=z[i+nx+1];
            if(z0===null||z1===null||z2===null||z3===null)return null;
            return triangleHeight(z0,z1,z2,z3,fx-ix,fy-iy);
        },maskBase:function(ctx,W,H,cw,ch,cx,cy){
            if(!mesh.visible)return;
            for(var y=0;y<ny-1;y++){
                var start=-1;
                for(var x=0;x<nx;x++){
                    var i=y*nx+x;
                    var valid=x<nx-1&&z[i]!==null&&z[i+1]!==null&&z[i+nx]!==null&&z[i+nx+1]!==null;
                    if(valid&&start<0)start=x;
                    if(!valid&&start>=0){
                        var left=(b[0]+start*dx-cx+W/2)/W*cw,right=(b[0]+x*dx-cx+W/2)/W*cw;
                        var top=(H/2-(b[1]+(y+1)*dy-cy))/H*ch,bottom=(H/2-(b[1]+y*dy-cy))/H*ch;
                        ctx.fillRect(left-0.55,top-0.55,right-left+1.1,bottom-top+1.1);start=-1;
                    }
                }
            }
        },update:function(){
            var p=geo.attributes.position;
            for(var i=0;i<z.length;i++)p.setY(i,sc.state.relief&&z[i]!==null?z[i]-sc.getDatum():0);
            p.needsUpdate=true;geo.computeVertexNormals();geo.computeBoundingSphere();
        },dispose:function(){delete sc.lasGround[id];sc.scene.remove(mesh);geo.dispose();mat.dispose();if(!sc.isDisposed())sc.scheduleRelief();}};
        sc.lasGround[id]=api;api.update();sc.scheduleRelief();return api;
    }
    function fetchTerrain(v,c){
        if(!c.terrain_available)return Promise.resolve();
        return getJSON(API+'/las/'+c.id+'/terrain?code='+encodeURIComponent(v.code)).then(function(d){
            var st=v.clouds[c.id];if(!v.alive||!st)return;
            if(st.terrain){try{st.terrain.dispose();}catch(_){}}
            st.terrain=TerrainLayer(v.sc,c.id,d);st.terrain.mesh.visible=st.visible;v.sc.scheduleRelief();
        }).catch(function(e){
            if(v.alive&&v.clouds[c.id]){v.clouds[c.id].pointStatus='Рельеф LAS: '+e.message;renderClouds(v);}
        });
    }
    function PointLayer(sc){
        var group=new T.Group(),chunks=[],count=0;sc.scene.add(group);
        var mat=new T.PointsMaterial({size:0.09,sizeAttenuation:true,vertexColors:true});
        function updateChunk(c){
            var p=c.mesh.geometry.attributes.position,a=c.data;
            for(var i=0;i<a.length/8;i++){
                var x=a[i*8]-sc.cx,y=a[i*8+1]-sc.cy;
                // Native absolute LAS Z (including zero), never clamp/drop H=0.
                p.setXYZ(i,x,(sc.state.relief?a[i*8+2]-sc.getDatum():a[i*8+3])+0.015,-y);
            }
            p.needsUpdate=true;c.mesh.geometry.computeBoundingSphere();
        }
        return {group:group,add:function(a){
            if(!a.length)return;
            var n=a.length/8,pos=new Float32Array(n*3),col=new Float32Array(n*3);
            for(var i=0;i<n;i++)col.set([a[i*8+5],a[i*8+6],a[i*8+7]],i*3);
            var geo=new T.BufferGeometry();geo.setAttribute('position',new T.BufferAttribute(pos,3));geo.setAttribute('color',new T.BufferAttribute(col,3));
            var c={data:a,mesh:new T.Points(geo,mat)};chunks.push(c);group.add(c.mesh);updateChunk(c);count+=n;
        },count:function(){return count;},update:function(){chunks.forEach(updateChunk);},dispose:function(){
            sc.scene.remove(group);chunks.forEach(function(c){c.mesh.geometry.dispose();});mat.dispose();chunks=[];
        }};
    }
    function loadPoints(v,id,all){
        var st=v.clouds[id];if(!st||st.pointLoading)return;
        if(!st.meta.stored_points){toast('Это старая обработка: загрузите исходный LAS заново для точек и грунта.',true);return;}
        if(all&&st.meta.stored_points>1000000&&!confirm('Загрузить все '+fmt(st.meta.stored_points)+' точек? Большое облако может занять сотни МБ памяти и замедлить браузер. Загрузку можно остановить.'))return;
        st.stopPoints=false;st.pointLoading=true;
        var gen=st.pointGeneration=(st.pointGeneration||0)+1;
        st.pointAbort=new AbortController();st.pointOffset=st.pointOffset||0;
        if(!st.points)st.points=PointLayer(v.sc);
        st.points.group.visible=st.visible;
        function current(){return v.alive&&v.clouds[id]===st&&st.pointGeneration===gen;}
        function step(){
            if(!current()||st.stopPoints)return Promise.resolve();
            var url=API+'/las/'+id+'/points?code='+encodeURIComponent(v.code)+'&offset='+st.pointOffset+'&limit=100000';
            return fetch(url,{credentials:'same-origin',cache:'no-store',signal:st.pointAbort.signal}).then(function(r){
                if(!r.ok)return r.json().catch(function(){return {};}).then(function(j){throw new Error(j.detail||'Точки LAS: '+r.status);});
                var total=+r.headers.get('X-Points-Total'),next=+r.headers.get('X-Next-Offset');
                return r.arrayBuffer().then(function(buf){return {total:total,next:next,buf:buf};});
            }).then(function(r){
                if(!current()||st.stopPoints)return;
                var a=new Float32Array(r.buf);if(a.length%8)throw new Error('Повреждён формат точек LAS');
                if(a.length&&!v.sc.hasLASDatum()){var z=a[2];for(var i=0;i<a.length;i+=8)z=Math.min(z,a[i+2]);v.sc.setDatum(z);}
                st.points.add(a);st.pointOffset=r.next;
                st.pointStatus='Видно на выбранной территории: '+fmt(st.points.count())+' · проверено '+fmt(r.next)+' / '+fmt(r.total)+' точек исходного облака'+(r.next>=r.total?' · все порции обработаны':'');
                renderClouds(v);
                if(all&&r.next<r.total)return new Promise(function(resolve){setTimeout(resolve,20);}).then(step);
            });
        }
        st.pointStatus='Загрузка точек (H=0 не исключается)…';renderClouds(v);
        step().catch(function(e){if(current()){if(e.name==='AbortError')st.pointStatus+=' · остановлено';else{st.pointStatus=e.message;toast(e.message,true);}}})
            .finally(function(){if(current()){st.pointLoading=false;st.pointAbort=null;renderClouds(v);}});
    }

    /* ───────────────────────── облака: список, загрузка, статистика ───────────────────────── */
    function loadClouds(v, first) {
        if(v.uploadOnly)return Promise.resolve();
        if (!v.alive) return;
        return getJSON(API + '/las?code=' + encodeURIComponent(v.code)).then(function (j) {
            if (!v.alive) return;
            v.cloudList = j.items || [];
            var running = false;
            v.cloudList.forEach(function (c) {
                if (c.state === 'queued' || c.state === 'running' || c.state === 'uploading' || c.state === 'finalizing') running = true;
                if (c.state === 'done' && (c.in_scope || c.code === v.code) && !v.clouds[c.id]) {
                    v.clouds[c.id] = { meta: c, visible: true, layer: null, loading: true };
                    fetchTerrain(v,c).then(function(){if(v.alive&&v.clouds[c.id])fetchTrees(v,c,false);});
                }
            });
            renderClouds(v);
            clearTimeout(v.pollT);
            if (running) v.pollT = setTimeout(function () { loadClouds(v, false); }, 2000);
        }).catch(function (e) {
            var box = v.lasCard && v.lasCard.querySelector('.v3d-clouds');
            if (box) box.innerHTML = '<div class="sub" style="color:#ff9d9d">' + esc(e.message) + '</div>';
        });
    }
    function fetchTrees(v, c, fly) {
        fetch(API + '/las/' + c.id + '/trees?code=' + encodeURIComponent(v.code) + '&limit=' + MAX_TREES, { credentials: 'same-origin', cache: 'no-store' }).then(function (r) {
            if (!r.ok) throw new Error('деревья не загружены (' + r.status + ')');
            return r.arrayBuffer();
        }).then(function (buf) {
            var st = v.clouds[c.id];
            if (!v.alive || !st) return;
            if (buf.byteLength % 28) throw new Error('повреждён формат деревьев');
            if (st.layer) { try { st.layer.dispose(); } catch (_) {} }
            st.layer = TreeLayer(v.sc, new Float32Array(buf));
            st.loading = false;
            st.layer.setVisible(st.visible, v.filter);
            if ((c.trees || 0) > st.layer.n) toast('Показаны ' + fmt(st.layer.n) + ' равномерно выбранных деревьев из ' + fmt(c.trees) + ' (статистика — по всем)');
            if (fly) flyTo(v.sc, st.layer.center[0], -st.layer.center[1], Math.max(120, st.layer.size * 1.1));
            renderClouds(v);
        }).catch(function (e) {
            var st = v.clouds[c.id];
            if (!v.alive || !st) return;
            st.loading = false; renderClouds(v);
            toast('Облако «' + (c.name || c.id) + '»: ' + e.message, true);
        });
    }
    function renderClouds(v) {
        if(v.uploadOnly)return;
        var box = v.lasCard.querySelector('.v3d-clouds');
        var list = (v.cloudList || []);
        if (!list.length) { box.innerHTML = '<div class="sub">Для этого лесхоза облаков ещё нет.</div>'; renderStats(v); return; }
        box.innerHTML = list.map(function (c) {
            var st = v.clouds[c.id];
            if (c.state === 'done') {
                var other = !c.in_scope && c.code !== v.code;
                return '<div class="cl" data-id="' + esc(c.id) + '"><div class="t">' +
                    (other ? '<i class="fa-solid fa-circle-info" style="color:#ffd54a"></i>' : '<input type="checkbox" data-a="vis"' + (st && st.visible ? ' checked' : '') + '>') +
                    '<span title="' + esc(c.name) + '">' + esc(c.name || c.id) + '</span>' +
                    (other ? '' : '<button type="button" data-a="fly" title="Показать деревья"><i class="fa-solid fa-location-arrow"></i></button>') +
                    (v.caps && v.caps.can_upload ? '<button type="button" data-a="del" title="Удалить облако"><i class="fa-solid fa-trash"></i></button>' : '') +
                    '</div><div class="s">' + (other ? 'Относится к: <b>' + esc(c.leshoz) + '</b> <button type="button" data-a="open" data-code="' + esc(c.code) + '">открыть</button>' :
                        fmt(c.trees) + ' дер.: ' + fmt(c.conifer) + ' хв. / ' + fmt(c.deciduous) + ' лист. · ' + fmt(c.area_ha, 1) + ' га' +
                        (st && st.loading ? ' · загрузка…' : '') + (c.inside === false ? ' · <span style="color:#ffd54a">вне границы</span>' : '')) + '</div>' + locationHTML(c,false) +
                    (!other ? '<div class="row"><button type="button" data-a="points">Точки: первая порция</button><button type="button" data-a="allpoints">Все точки</button><button type="button" data-a="stoppoints">Стоп</button><button type="button" data-a="clearpoints">Убрать точки</button></div><div class="sub v3d-point-status">'+esc(st&&st.pointStatus||'Высота 0 м сохраняется; полная загрузка требует памяти.')+'</div>' : '') + '</div>';
            }
            if (c.state === 'error') return '<div class="cl" data-id="' + esc(c.id) + '"><div class="t"><i class="fa-solid fa-triangle-exclamation" style="color:#ff8a80"></i><span>' + esc(c.name || c.id) + '</span>' +
                (v.caps && v.caps.can_upload ? '<button type="button" data-a="del" title="Удалить"><i class="fa-solid fa-trash"></i></button>' : '') +
                '</div><div class="s" style="color:#ff9d9d">' + esc(c.message || 'Ошибка обработки') + '</div></div>';
            return '<div class="cl" data-id="' + esc(c.id) + '"><div class="t"><i class="fa-solid fa-gear fa-spin" style="color:#82e938"></i><span>' + esc(c.name || c.id) + '</span></div>' +
                '<div class="s">' + esc(c.stage || 'В очереди') + ' · ' + fmt(Math.max(0, Math.min(100, +c.progress || 0))) + '%</div><div class="bar"><i style="width:' + Math.max(0, Math.min(100, +c.progress || 0)) + '%"></i></div></div>';
        }).join('');
        if (!box._wired) {
            box._wired = true;
            box.addEventListener('click', function (e) {
                var el = e.target.closest('[data-a]'); if (!el) return;
                var id = el.closest('.cl').getAttribute('data-id'), a = el.getAttribute('data-a'), st = v.clouds[id];
                if (a === 'vis' && st) { st.visible = el.checked; if(st.points)st.points.group.visible=st.visible;if(st.terrain){st.terrain.mesh.visible=st.visible;v.sc.scheduleRelief();} if (st.layer) st.layer.setVisible(st.visible, v.filter); renderStats(v); }
                if(a==='points'||a==='allpoints')loadPoints(v,id,a==='allpoints');
                if(a==='stoppoints'&&st){st.stopPoints=true;if(st.pointAbort)st.pointAbort.abort();}
                if(a==='clearpoints'&&st){st.stopPoints=true;if(st.pointAbort)st.pointAbort.abort();if(st.points){st.points.dispose();st.points=null;}st.pointGeneration=(st.pointGeneration||0)+1;st.pointLoading=false;st.pointOffset=0;st.pointStatus='Точки убраны';renderClouds(v);}
                if (a === 'fly' && st && st.layer) flyTo(v.sc, st.layer.center[0], -st.layer.center[1], Math.max(120, st.layer.size * 1.1));
                if (a === 'open') openViewer(el.getAttribute('data-code'));
                if (a === 'del') {
                    if (!confirm('Удалить облако и найденные деревья?')) return;
                    fetch(API + '/las/' + id, { method: 'DELETE', credentials: 'same-origin', headers: { 'X-CSRFToken': csrf() } }).then(function (r) {
                        if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) { throw new Error(j.detail || r.status); });
                        if(st){st.stopPoints=true;if(st.pointAbort)st.pointAbort.abort();if(st.points)st.points.dispose();if(st.terrain)st.terrain.dispose();}
                        if (st && st.layer) st.layer.dispose();
                        delete v.clouds[id];
                        loadClouds(v, false);
                    }).catch(function (er) { toast('Удаление: ' + er.message, true); });
                }
            });
        }
        renderStats(v);
    }
    function renderStats(v) {
        if(v.uploadOnly)return;
        var box = v.lasCard.querySelector('.v3d-stats');
        var cs = Object.keys(v.clouds).map(function (k) { return v.clouds[k]; }).filter(function (c) { return c.visible && c.meta; });
        if (!cs.length) { box.innerHTML = ''; return; }
        var tot = 0, con = 0, dec = 0, hs = 0, ds = 0, hmax = 0, meas = 0, cls = [[0, 0], [0, 0], [0, 0], [0, 0]];
        cs.forEach(function (c) {
            var m = c.meta; tot += m.trees; con += m.conifer; dec += m.deciduous; hs += m.h_mean * m.trees; ds += m.dbh_mean * m.trees;
            hmax = Math.max(hmax, m.h_max); meas += m.dbh_measured || 0;
            (m.h_classes || []).forEach(function (h, i) { cls[i][0] += h.conifer; cls[i][1] += h.deciduous; });
        });
        var mx = Math.max.apply(null, cls.map(function (c) { return c[0] + c[1]; }).concat([1]));
        var names = ['до 10 м', '10–20 м', '20–30 м', '30 м и выше'];
        box.innerHTML = '<div class="cl" style="border-top:1px solid rgba(255,255,255,.08);margin-top:4px"><table>' +
            '<tr><td>Деревьев</td><td><b>' + fmt(tot) + '</b></td></tr>' +
            '<tr><td>Хвойные</td><td><span class="lg" style="background:#2f7a3d"></span><b>' + fmt(con) + '</b> (' + fmt(100 * con / Math.max(1, tot)) + '%)</td></tr>' +
            '<tr><td>Лиственные</td><td><span class="lg" style="background:#8cc63f"></span><b>' + fmt(dec) + '</b> (' + fmt(100 * dec / Math.max(1, tot)) + '%)</td></tr>' +
            '<tr><td>Высота</td><td>средняя <b>' + fmt(hs / Math.max(1, tot), 1) + ' м</b>, макс. ' + fmt(hmax, 1) + ' м</td></tr>' +
            '<tr><td>Ø ствола</td><td>средний <b>' + fmt(ds / Math.max(1, tot), 0) + ' см</b><br><span class="sub">измерено по точкам ствола: ' + fmt(meas) + ', остальные — оценка по H и кроне</span></td></tr>' +
            '</table><div class="hc">' + cls.map(function (c, i) {
                return '<span class="sub">' + names[i] + '</span><span class="b"><i style="width:' + (100 * c[0] / mx) + '%;background:#2f7a3d"></i><i style="width:' + (100 * c[1] / mx) + '%;background:#8cc63f"></i></span><span>' + fmt(c[0] + c[1]) + '</span>';
            }).join('') + '</div></div>';
    }
    function buildUpload(v) {
        var box = v.lasCard.querySelector('.v3d-up');
        getJSON(API + '/las/caps').then(function (caps) {
            v.caps = caps;
            if (!v.alive) return;
            if (!caps.can_upload) { box.innerHTML = '<div class="note">Загрузка облаков — для администратора (войдите в систему).</div>'; renderClouds(v); return; }
            box.innerHTML =
                '<div class="row" style="margin-top:8px"><button type="button" class="primary" data-u="pick"><i class="fa-solid fa-upload"></i> Загрузить .las / .laz</button>' +
                '<input type="file" accept=".las,.laz" hidden></div>' +
                '<div class="v3d-upf" hidden>' +
                '<div class="row"><span class="v3d-fn" style="color:#fff;word-break:break-all"></span></div>' +
                '<div class="row"><label>СК облака</label><select data-u="crs">' +
                '<option value="auto">авто (WGS-84 lon/lat → UTM WGS-84)</option>' +
                '<option value="EPSG:4326">WGS-84 lon/lat → UTM WGS-84</option>' +
                '<option value="EPSG:32635">UTM 35N (EPSG:32635)</option><option value="EPSG:32634">UTM 34N (EPSG:32634)</option><option value="EPSG:32636">UTM 36N (EPSG:32636)</option>' +
                '<option value="custom">другая (EPSG/WKT)…</option></select>' +
                '<input type="text" data-u="crs2" placeholder="EPSG:XXXX" hidden style="width:110px"></div>' +
                '<div class="row"><label>Порода (оценка)</label><select data-u="sp"><option value="auto">авто (по форме кроны)</option>' +
                '<option value="conifer">все хвойные</option><option value="deciduous">все лиственные</option></select></div>' +
                '<div class="row"><button type="button" class="primary" data-u="go"><i class="fa-solid fa-play"></i> Построить деревья</button><button type="button" data-u="cancel">Отмена</button></div>' +
                '<div class="bar" hidden style="margin-left:0"><i style="width:0"></i></div><div class="sub v3d-upst"></div></div>' +
                '<div class="note">Деревья определяются по модели высот полога: высота, Ø кроны, порода (хвойные/лиственные — по форме вершины и кроны, интенсивности). Ø ствола — по точкам ствола на 1,3 м, если их хватает, иначе оценка. Все конечные точки, включая H≈0, сохраняются. Низкая растительность от 0,25 м включена в поиск вершин; точки класса 3 сохраняются и при H=0. Порода и число саженцев — оценка, не достоверная инвентаризация. Ø на 1,3 м для растений ниже 1,3 м не определяется.</div>';
            var inp = box.querySelector('input[type=file]'), form = box.querySelector('.v3d-upf'), file = null;
            var sel = box.querySelector('select[data-u=crs]'), crs2 = box.querySelector('input[data-u=crs2]');
            sel.addEventListener('change', function () { crs2.hidden = sel.value !== 'custom'; });
            box.querySelector('[data-u=pick]').addEventListener('click', function () { inp.click(); });
            inp.addEventListener('change', function () {
                file = inp.files && inp.files[0];
                if (!file) return;
                if (!/\.la[sz]$/i.test(file.name)) { toast('Нужен файл .las или .laz', true); return; }
                /* размер не ограничиваем в браузере — решает сервер (FOREST3D_LAS_MAX_MB, по умолчанию без лимита) */
                form.hidden = false;
                box.querySelector('.v3d-fn').textContent = file.name + ' · ' + fmt(file.size / 1048576, 1) + ' МБ';
            });
            box.querySelector('[data-u=cancel]').addEventListener('click', function () { form.hidden = true; file = null; inp.value = ''; if (v.xhr) v.xhr.abort(); });
            box.querySelector('[data-u=go]').addEventListener('click', function () {
                if (!file) return;
                var crs = sel.value === 'custom' ? (crs2.value.trim() || 'auto') : sel.value;
                var bar = form.querySelector('.bar'), bi = bar.querySelector('i'), stl = form.querySelector('.v3d-upst');
                bar.hidden = false; stl.textContent = 'Передача файла…';
                // загрузка ЧАСТЯМИ по 32 МБ: обходит лимит размера запроса nginx/прокси, повтор при сбое сети
                var q = '?name=' + encodeURIComponent(file.name) + '&size=' + file.size + '&crs=' + encodeURIComponent(crs) +
                    '&species=' + box.querySelector('select[data-u=sp]').value;
                var jobId = null, cancelled = false, t0 = Date.now();
                v.xhr = { abort: function () { cancelled = true; if (v._px) v._px.abort(); } };
                function req(method, u, body, onprog) {
                    return new Promise(function (res, rej) {
                        var x = v._px = new XMLHttpRequest();
                        x.open(method, u);
                        x.timeout = 30 * 60 * 1000;
                        x.setRequestHeader('X-CSRFToken', csrf());
                        if (body) x.setRequestHeader('Content-Type', 'application/octet-stream');
                        if (onprog) x.upload.onprogress = onprog;
                        x.onload = function () {
                            var j = {}; try { j = JSON.parse(x.responseText); } catch (e) {}
                            if (x.status === 200) res(j);
                            else { var er = new Error(j.detail || ('HTTP ' + x.status + (x.status === 413 ? ' — превышен лимит размера запроса nginx' : ''))); er.status = x.status; rej(er); }
                        };
                        x.onerror = function () { var er = new Error('сеть'); er.status = 0; rej(er); };
                        x.ontimeout = function () { var er = new Error('тайм-аут сети'); er.status = 0; rej(er); };
                        x.onabort = function () { var er = new Error('отменено'); er.status = -1; rej(er); };
                        x.send(body || null);
                    });
                }
                function fail(e) {
                    v.xhr = null; bar.hidden = true; stl.textContent = '';
                    if (!cancelled) toast('Загрузка: ' + e.message, true);
                    if (jobId) fetch(API + '/las/' + jobId, { method: 'DELETE', credentials: 'same-origin', headers: { 'X-CSRFToken': csrf() } }).catch(function () {});
                }
                req('POST', API + '/las/upload/init' + q).then(function (j) {
                    jobId = j.id;
                    var part = (j.part_mb || 32) * 1048576, off = 0;
                    function next() {
                        if (cancelled) return Promise.reject(Object.assign(new Error('отменено'), { status: -1 }));
                        if (off >= file.size) return Promise.resolve();
                        var end = Math.min(file.size, off + part), tries = 0;
                        function send() {
                            return req('PUT', API + '/las/upload/' + jobId + '/part?offset=' + off, file.slice(off, end), function (e) {
                                var done = off + (e.loaded || 0), p = 100 * done / file.size, sp = done / Math.max(1, (Date.now() - t0) / 1000) / 1048576;
                                bi.style.width = p + '%';
                                stl.textContent = 'Передача: ' + fmt(p, 1) + '% · ' + fmt(done / 1073741824, 2) + ' из ' + fmt(file.size / 1073741824, 2) + ' ГБ · ' + fmt(sp, 1) + ' МБ/с';
                            }).catch(function (e) {
                                var retryable = e.status === 0 || e.status === 408 || e.status === 429 || e.status >= 500;
                                if (e.status === -1 || !retryable || ++tries > 5) throw e;
                                stl.textContent = 'Сбой сети, повтор ' + tries + '/5…';
                                return new Promise(function (r) { setTimeout(r, 2000 * tries); }).then(send);
                            });
                        }
                        return send().then(function () { off = end; return next(); });
                    }
                    return next();
                }).then(function () {
                    stl.textContent = 'Файл передан, запускаю обработку…';
                    return req('POST', API + '/las/upload/' + jobId + '/finish');
                }).then(function (j) {
                    v.xhr = null;
                    form.hidden = true; bar.hidden = true; inp.value = ''; file = null;
                    toast('Облако загружено — идёт обработка. Деревья появятся автоматически.');
                    try{localStorage.setItem('forest3d:last-job',j.id);}catch(e){}
                    watchJob(v, j.id);
                    loadClouds(v, false);
                }).catch(fail);
            });
            renderClouds(v);
        }).catch(function () { box.innerHTML = ''; });
    }
    function watchJob(v, id) {
        var failures=0,lastStage='Ожидание статуса';
        function message(text,retry){
            if(!v.uploadOnly||!v.alive)return;
            var box=v.lasCard.querySelector('.v3d-location-result');box.textContent=text+' · ID: '+id;
            var diag=document.createElement('a');diag.href=API+'/las/'+id+'/diagnostics';diag.target='_blank';diag.rel='noopener';diag.textContent=' Диагностика задания';box.appendChild(diag);
            if(retry){var b=document.createElement('button');b.type='button';b.textContent='Проверить снова';b.onclick=poll;box.appendChild(b);}
        }
        function poll() {
            if (!v.alive) return;
            var controller=new AbortController(),timer=setTimeout(function(){controller.abort();},15000);
            fetch(API+'/las/job/'+id,{credentials:'same-origin',cache:'no-store',signal:controller.signal}).then(function(r){
                if(!r.ok){var e=new Error('HTTP '+r.status);e.status=r.status;throw e;}return r.json();
            }).then(function (s) {
                clearTimeout(timer);failures=0;lastStage=(s.stage||'Обработка')+' · '+fmt(s.progress||0)+'%';
                if (!v.alive) return;
                if(v.uploadOnly&&s.state!=='done'){var detail=s.fitted_stems!==undefined?' · стволы '+fmt(s.fitted_stems)+' / '+fmt(s.total_stems):s.located_points!==undefined?' · точки '+fmt(s.located_points)+' / '+fmt(s.total_points):'';message(lastStage+detail+(s.message?' · '+s.message:''),false);}
                if (s.state === 'done') {
                    var m = s.meta || {};
                    if(v.uploadOnly){
                        v.lasCard.querySelector('.v3d-location-result').innerHTML='<h4>Местоположение LAS определено</h4>'+locationHTML(m,true);
                        toast('LAS: лесхозов '+(m.forest_count||0)+', лесничеств '+(m.forestry_count||0));return;
                    }
                    toast('LAS: лесхозов '+(m.forest_count||0)+', лесничеств '+(m.forestry_count||0));
                    if (m.code && m.code !== v.code && !(m.forestries||[]).some(function(r){return r.code===v.code;}) && !(m.forests||[]).some(function(r){return r.code===v.code;})) toast('Облако относится к лесхозу «' + m.leshoz + '» — откройте его в 3D', false);
                    else toast('Готово: ' + fmt(m.trees) + ' деревьев (' + fmt(m.conifer) + ' хв., ' + fmt(m.deciduous) + ' лист.)');
                    loadClouds(v, false);
                    var wait = setInterval(function () {
                        var st = v.clouds[id];
                        if (!v.alive) { clearInterval(wait); return; }
                        if (!st) return;   // облако ещё не добавлено в сцену — ждём (до 30 с)
                        if (st.layer) { clearInterval(wait); flyTo(v.sc, st.layer.center[0], -st.layer.center[1], Math.max(120, st.layer.size * 1.1)); }
                    }, 300);
                    setTimeout(function () { clearInterval(wait); }, 30000);
                    return;
                }
                if (s.state === 'error') { message('Ошибка: '+(s.message||'Обработка прервана'),true);toast('Обработка облака: ' + (s.message || 'ошибка'), true); loadClouds(v, false); return; }
                setTimeout(poll, 1500);
            }).catch(function(e){
                clearTimeout(timer);if(!v.alive)return;failures++;
                if(e.status===401||e.status===403){message('Сессия администратора истекла или доступ закрыт. Подтвердите вход и проверьте задание снова. Последний этап: '+lastStage,true);return;}
                message('Не удалось получить статус ('+(e.name==='AbortError'?'тайм-аут':e.message)+'). Последний этап: '+lastStage+'. Повтор '+failures,true);
                setTimeout(poll,Math.min(15000,4000*failures));
            });
        }
        poll();
    }

    function closeViewer(fitMap) {
        var v = viewer;
        if (!v) return;
        v.alive = false;
        viewer = null;
        cancelAnimationFrame(v.raf);
        clearInterval(v.fitTimer);
        clearTimeout(v.pollT); clearTimeout(v.ctxT);
        window.removeEventListener('resize', v.onResize);
        if (v.sc && v.sc.markDisposed) v.sc.markDisposed();
        if (v.sc && v.onCtxLost) {
            var cvs = v.sc.renderer.domElement;
            cvs.removeEventListener('webglcontextlost', v.onCtxLost, false);
            cvs.removeEventListener('webglcontextrestored', v.onCtxRestored, false);
        }
        if (v.xhr) { try { v.xhr.abort(); } catch (e) {} }
        if (v.ro) v.ro.disconnect();
        Object.keys(v.clouds).forEach(function (k) { var st=v.clouds[k];st.stopPoints=true;if(st.pointAbort)st.pointAbort.abort();try{if(st.points)st.points.dispose();if(st.terrain)st.terrain.dispose();if(st.layer)st.layer.dispose();}catch(e){} });
        try{if(v.tax)v.tax.dispose();}catch(e){}
        try{if(v.ll)v.ll.dispose();}catch(e){}
        try{if(v.dem)v.dem.dispose();}catch(e){}
        try{if(v.mapLayers)v.mapLayers.dispose();}catch(e){}
        try{if(v.drone)v.drone.dispose();}catch(e){}
        if (v.sc) {
            try {
                v.sc.controls.dispose();
                v.sc.scene.traverse(function (o) {
                    if (o.geometry) o.geometry.dispose();
                    if (o.material) { [].concat(o.material).forEach(function (m) { if (m.alphaMap) m.alphaMap.dispose(); m.dispose(); }); }
                });
                v.sc.renderer.dispose();
                if (v.sc.renderer.forceContextLoss) v.sc.renderer.forceContextLoss();
            } catch (e) {}
        }
        v.ov.remove();
        if (!picking) document.removeEventListener('keydown', onKey, true);
        setBtnState();
        var map = getMap();
        if (fitMap && map && v.data && window.ol) {
            try {
                var ext = ol.proj.transformExtent(v.data.bbox_wgs84, 'EPSG:4326', map.getView().getProjection());
                map.getView().fit(ext, { padding: [60, 80, 60, 80], duration: 600 });
            } catch (e) {}
        }
        if (map) setTimeout(function () { map.updateSize(); }, 50);
    }

    window.forest3d = { open: function(c){refreshAccess().then(function(a){if(a.allowed)openViewer(c);});}, close: function () { closeViewer(true); }, pick: function(){refreshAccess().then(function(a){if(a.allowed)startPick();});}, upload:openAutoUpload };

    /* ждём, пока map-core.js создаст кнопки карты */
    function init() {
        var tries = 0;
        (function wait() {
            if (document.getElementById('map-geoloc-btn') || document.getElementById('map-fullscreen-btn')) { refreshAccess(); return; }
            if (++tries > 120) { refreshAccess(); return; }   // ~60 с — ставим кнопку в любом случае
            setTimeout(wait, 500);
        })();
        setInterval(function(){if(!document.hidden)refreshAccess();},15000);
        document.addEventListener('visibilitychange',function(){if(!document.hidden&&accessState)refreshAccess();});
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
