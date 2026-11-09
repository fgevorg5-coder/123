/* Manuals workspace v7 (+v18 hooks: library, toolbar, reader). Web editions never silently overwrite original Office/PDF files. */
(function(){
'use strict';
var B=window.ManualsBase;if(!B)return;
if(B.cancelLegacy)B.cancelLegacy();
var S=B.state,main=B.main,doc=null,seq=0,draftTimer=null,selection=null;
var esc=B.esc;
document.body.classList.add('mw-enabled');
function endpoint(fid){return '/api/manuals-editions/'+encodeURIComponent(fid);}
async function http(url,options){var r=await fetch(url,Object.assign({credentials:'same-origin',cache:'no-store'},options||{})),d=await r.json().catch(function(){return {};});if(!r.ok){var e=new Error(d.detail||('Ошибка '+r.status));e.status=r.status;throw e;}return d;}
function token(){var m=document.querySelector('meta[name="csrf-token"]');return m?m.content:'';}
function button(label,action,kind){return '<button type="button" class="mw-btn '+(kind||'')+'" data-ws="'+action+'">'+label+'</button>';}
function urlSafe(v,image){v=(v||'').trim();if(/[\x00-\x20\x7f\\]/.test(v))return false;var d;try{d=decodeURIComponent(v);}catch(_){return false;}if(image&&/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/i.test(v))return true;if(/^\/\//.test(d)||d.indexOf('\\')>=0)return false;if(image)return /^\/(api\/manuals\/|uploads\/|static\/)/.test(d);return /^(https?:|mailto:|\/(?!\/)|#)/i.test(d);}
function clean(value){
 var parsed=new DOMParser().parseFromString(value||'','text/html');
 parsed.querySelectorAll('script,style,iframe,object,embed,svg,math,template,noscript,form,button,input,textarea,select,meta,link,base').forEach(function(n){n.remove();});
 var tags='p div span br h1 h2 h3 h4 h5 h6 strong b em i u s strike sub sup ul ol li blockquote pre code hr table thead tbody tfoot tr td th caption colgroup col img a figure figcaption'.split(' ');
 var styles='text-align font-weight font-style text-decoration color background-color font-size font-family width height max-width border border-collapse vertical-align padding margin margin-left'.split(' ');
 Array.from(parsed.body.querySelectorAll('*')).forEach(function(n){
  if(tags.indexOf(n.tagName.toLowerCase())<0){n.replaceWith.apply(n,Array.from(n.childNodes));return;}
  Array.from(n.attributes).forEach(function(a){var k=a.name.toLowerCase();if(k==='style'){var css=document.createElement('span');styles.forEach(function(p){var v=n.style.getPropertyValue(p);if(v&&!/url|expression|import|behavior|binding/i.test(v))css.style.setProperty(p,v);});n.setAttribute('style',css.getAttribute('style')||'');}
   else if(k==='src'&&n.tagName==='IMG'){if(!urlSafe(a.value,true))n.removeAttribute(k);}
   else if(k==='href'&&n.tagName==='A'){if(!urlSafe(a.value,false))n.removeAttribute(k);}
   else if(['alt','title'].indexOf(k)>=0){}
   else if(['width','height','colspan','rowspan','start'].indexOf(k)>=0&&/^\d{1,4}%?$/.test(a.value)){}
   else n.removeAttribute(k);
  });
  if(n.tagName==='A'){n.setAttribute('rel','noopener noreferrer');n.setAttribute('target','_blank');}
 });
 return parsed.body.innerHTML;
}
function draftKey(fid){return 'manuals_web_draft_v7_'+fid;}
function getDraft(fid){try{return JSON.parse(localStorage.getItem(draftKey(fid))||'null');}catch(_){return null;}}
function clearDraft(fid){try{localStorage.removeItem(draftKey(fid));}catch(_){}}
function writeDraft(){if(!doc||!doc.editing||!doc.dirty)return;var paper=main.querySelector('#mw-paper');if(!paper)return;try{localStorage.setItem(draftKey(doc.fid),JSON.stringify({html:paper.innerHTML,revision:doc.revision,source_ver:String(doc.f.ver||1),at:Date.now()}));status('Есть несохранённые правки · черновик в этом браузере');}catch(_){status('Есть несохранённые правки · черновик не записан, сохраните на сервере');}}
function dirty(){if(!doc||!doc.editing)return;doc.dirty=true;status('Есть несохранённые правки');clearTimeout(draftTimer);draftTimer=setTimeout(writeDraft,350);}
function status(text){var el=main.querySelector('#mw-status');if(el)el.textContent=text;}
function notice(text,kind,actions){var n=main.querySelector('#mw-notice');if(!n)return;n.hidden=!text;n.className='mw-notice '+(kind||'');n.innerHTML='<span>'+esc(text||'')+'</span>'+(actions||'');}
function leave(){if(doc&&doc.saving){B.toast('Дождитесь окончания сохранения',true);return false;}if(doc&&doc.dirty){writeDraft();if(!confirm('Есть несохранённые правки. Выйти из редактора? Сохранённый в этом браузере черновик можно восстановить позже.'))return false;}return true;}
function restoreHash(){if(doc)window.history.replaceState(null,'','#f='+doc.fid);}
function home(){
 if(!leave()){restoreHash();return;}++seq;doc=null;S.cur=null;B.list();
 if(window.ManualsV18&&window.ManualsV18.home(main))return;
 var groups=S.manuals.filter(function(m){return !S.q||(m.title+' '+(m.desc||'')+' '+(m.files||[]).map(function(f){return f.name;}).join(' ')).toLowerCase().indexOf(S.q.toLowerCase())>=0;});
 var html=groups.map(function(m){var files=(m.files||[]).filter(function(f){return !S.q||(m.title+' '+(m.desc||'')+' '+f.name).toLowerCase().indexOf(S.q.toLowerCase())>=0;});return '<section class="mw-group"><header class="mw-group-head"><div><h3>'+esc(m.title)+'</h3>'+(m.desc?'<p>'+esc(m.desc)+'</p>':'')+'</div><span class="mw-count">Файлов: '+files.length+'</span></header>'+files.map(function(f){return '<div class="mw-file-row"><span class="fi '+esc(f.ext.slice(1))+'">'+esc(f.ext.slice(1).toUpperCase())+'</span><div class="mw-file-name"><a href="#f='+encodeURIComponent(f.id)+'">'+esc(f.name.replace(/\.(docx?|pdf)$/i,''))+'</a><p>'+B.size(f.size)+' · '+B.date(f.uploaded)+'</p></div><div class="mw-row-actions"><a class="mw-btn" href="#f='+encodeURIComponent(f.id)+'">Читать</a>'+(B.admin?'<button class="mw-btn" data-open-edit="'+esc(f.id)+'">Редактировать</button>':'')+'</div></div>';}).join('')+(!files.length?'<div class="mw-file-row">Файлов пока нет. Добавьте PDF или Word в левом меню.</div>':'')+'</section>';}).join('');
 main.innerHTML='<div class="mw-home"><div class="mw-library">'+(window.GuideHub?window.GuideHub.markup(S.q):'')+'<h2 class="gs-documents-title">Документы библиотеки</h2>'+ (html||'<section class="mw-group"><div class="mw-placeholder"><h3>'+(S.q?'Ничего не найдено':'Методичек пока нет')+'</h3><p>'+(S.q?'Попробуйте другой поисковый запрос.':'Добавьте документы кнопкой «Новая методичка».')+'</p></div></section>')+'</div></div>';
}
function toolbar(){
 if(!doc)return;var fresh=B.find(doc.fid);if(fresh){doc.m=fresh.m;if(String(fresh.f.ver||1)===String(doc.f.ver||1))doc.f=fresh.f;}var el=main.querySelector('#mw-toolbar');if(!el)return;var f=doc.f;
 var more=(doc.edition.revision?'<a class="mw-btn" href="'+endpoint(doc.fid)+'/download">Скачать веб-редакцию HTML</a>'+button('Печать веб-редакции','print'):'')+
 '<a class="mw-btn" href="/api/manuals/files/'+encodeURIComponent(doc.fid)+'/download">Исходный '+esc(f.ext.slice(1).toUpperCase())+' ↓</a>'+
 (B.admin?button('Заменить исходный файл','replace')+button('Переименовать файл','rename')+button('История редакций','history')+button('Удалить файл','delete','danger'):'')+
 button(main.classList.contains('full')?'Обычный вид':'Во весь экран','full');
 var actions=doc.editing?button(doc.saving?'Сохраняю…':'Сохранить','save','primary')+button('К чтению','cancel')+button('Библиотека','home'):
 (B.admin?button(f.ext==='.docx'||doc.edition.revision?'Редактировать':'Создать веб-редакцию','edit','primary'):'')+
 button('Библиотека','home')+'<details class="mw-more"><summary class="mw-btn">Ещё ▾</summary><div class="mw-more-menu">'+more+'</div></details>';
 el.innerHTML='<div class="mw-doc-info"><div class="mw-breadcrumb">Методички / '+esc(doc.m.title)+'</div><h2>'+esc(f.name.replace(/\.(docx?|pdf)$/i,''))+'</h2><div class="mw-doc-meta">'+(doc.edition.revision?'Веб-редакция '+doc.edition.revision+' · '+B.date(doc.edition.saved_at):'Исходный '+esc(f.ext.slice(1).toUpperCase())+' · '+B.size(f.size))+(doc.editing?' · редактирование':'')+'</div><div class="mw-status" id="mw-status" role="status" aria-live="polite">'+(doc.saving?'Сохраняю на сервере…':doc.dirty?'Есть несохранённые правки':doc.editing?'Правки ещё не вносились':'Режим чтения')+'</div></div><div class="mw-doc-actions">'+actions+'</div>';
 if(doc.saving)el.querySelectorAll('button').forEach(function(b){b.disabled=true;});
 if(window.ManualsV18)window.ManualsV18.toolbar(doc,el);
}
function editorBar(){return '<details class="mw-format" '+(window.innerWidth>900?'open':'')+'><summary>Форматирование текста</summary><div class="mw-editbar" id="mw-editbar" role="toolbar" aria-label="Форматирование текста"><select aria-label="Стиль абзаца" id="mw-block"><option value="p">Обычный текст</option><option value="h1">Заголовок 1</option><option value="h2">Заголовок 2</option><option value="h3">Заголовок 3</option><option value="blockquote">Цитата</option></select>'+[['bold','Ж','Полужирный'],['italic','К','Курсив'],['underline','Ч','Подчёркнутый'],['insertUnorderedList','• Список','Маркированный список'],['insertOrderedList','1. Список','Нумерованный список'],['link','Ссылка','Добавить ссылку'],['image','Изображение','Вставить PNG/JPG/WebP'],['table','Таблица','Таблица 3 × 3'],['undo','Отмена','Отменить'],['redo','Повтор','Повторить']].map(function(t){return '<button type="button" data-command="'+t[0]+'" title="'+t[2]+'" aria-label="'+t[2]+'">'+t[1]+'</button>';}).join('')+'</div></details>';}
function shell(){main.innerHTML='<div class="mw-toolbar" id="mw-toolbar"></div><div class="mw-notice" id="mw-notice" role="status" aria-live="polite" hidden></div>'+(doc.editing?editorBar():'')+'<div class="mw-stage" id="mw-stage"></div><footer class="mw-bottom"><span>'+(doc.editing?'Веб-редакция · исходный файл не изменяется':'Текст и иллюстрации')+'</span><span>'+(doc.editing?'Ctrl / ⌘ + S — сохранить':'ОДЗиМЛ · база знаний')+'</span></footer>';toolbar();}
function paper(html,editing){var stage=main.querySelector('#mw-stage');stage.innerHTML='<div class="mw-scroll" id="mw-scroll"><article class="mw-paper" id="mw-paper" '+(editing?'contenteditable="true" role="textbox" aria-multiline="true" aria-label="Текст методички" spellcheck="true"':'')+' style="--z:1">'+clean(html)+'</article></div>'+(editing?'':'<nav class="mw-outline" id="mw-outline" aria-label="Содержание"></nav>');
 if(!editing){var heads=stage.querySelectorAll('h1,h2,h3'),out=stage.querySelector('#mw-outline');out.innerHTML=heads.length?'<h3>В документе</h3>':'';heads.forEach(function(h,i){h.id='mw-heading-'+i;var b=document.createElement('button');b.type='button';b.textContent=h.textContent;b.className=h.tagName==='H3'?'sub':'';b.onclick=function(){h.scrollIntoView({block:'start',behavior:'smooth'});};out.appendChild(b);});}
 else {var p=main.querySelector('#mw-paper');p.addEventListener('input',dirty);p.addEventListener('paste',function(e){e.preventDefault();var h=e.clipboardData.getData('text/html'),t=e.clipboardData.getData('text/plain');document.execCommand('insertHTML',false,h?clean(h):esc(t).replace(/\n/g,'<br>'));dirty();});p.addEventListener('drop',function(e){e.preventDefault();B.toast('Добавляйте иллюстрации кнопкой «Изображение».',true);});p.addEventListener('mouseup',rememberSelection);p.addEventListener('keyup',rememberSelection);p.focus();}
}
function renderReader(){shell();var body=doc.edition.revision?doc.edition.html:doc.source;
 if(body!==null&&body!==undefined)paper(body,false);
 else if(doc.f.ext==='.pdf')main.querySelector('#mw-stage').innerHTML='<iframe class="mw-pdf" title="'+esc(doc.f.name)+'" src="/api/manuals/files/'+encodeURIComponent(doc.fid)+'/raw?v='+encodeURIComponent(doc.f.ver||1)+'#view=FitH"></iframe>';
 else main.querySelector('#mw-stage').innerHTML='<div class="mw-placeholder"><h3>Не удалось открыть текст документа</h3><p>'+esc(doc.sourceError||'Для старого формата DOC загрузите версию DOCX или создайте отдельную веб-редакцию.')+'</p>'+button('Повторить загрузку','reload')+'</div>';
 if(!doc.apiReady&&B.admin)notice('Чтение доступно, но сервер редакций не отвечает'+(doc.apiError?' ('+doc.apiError+')':'')+'. Проверьте, что файл manuals_editor_api.py (v20.10) лежит рядом с app.py, и перезапустите приложение — README_DEPLOY_RU, раздел «Редактор методичек».','warn');
 else if(doc.edition.revision&&String(doc.edition.source_ver)!==String(doc.f.ver||1))notice('Исходный файл обновлён после этой веб-редакции. Проверьте изменения перед публикацией новых правок.','warn');
 else {var draft=getDraft(doc.fid);if(draft&&B.admin)notice('В этом браузере есть несохранённый черновик.','warn',button('Восстановить','restore-draft')+button('Удалить черновик','delete-draft'));}
 if(window.ManualsV18)window.ManualsV18.reader(doc);
}
async function open(fid,force,edit){
 if(doc&&doc.fid===fid&&!force){if(edit)beginEdit();return true;}
 if(!leave()){restoreHash();return false;}var x=B.find(fid);if(!x){home();return false;}
 clearTimeout(draftTimer);var ticket=++seq;S.cur=fid;S.open[x.m.id]=true;B.saveOpen();B.list();document.body.classList.remove('side-on');
 main.innerHTML='<div class="mw-placeholder" role="status"><h3>Открываю методичку…</h3><p>'+esc(x.f.name)+'</p></div>';
 var results=await Promise.all([http(endpoint(fid)).then(function(e){return {ok:true,data:e};}).catch(function(e){return {ok:false,error:e};}),x.f.ext==='.docx'?http('/api/manuals/files/'+encodeURIComponent(fid)+'/html?v='+encodeURIComponent(x.f.ver||1)).then(function(d){return {html:clean(d.html||'')};}).catch(function(e){return {html:null,error:e.message};}):Promise.resolve({html:null})]);
 if(ticket!==seq)return false;
 doc={fid:fid,f:x.f,m:x.m,edition:results[0].ok?results[0].data:{revision:0,html:null},revision:results[0].ok?results[0].data.revision:0,apiReady:results[0].ok,apiError:results[0].ok?'':String(results[0].error&&results[0].error.status?'код '+results[0].error.status:(results[0].error&&results[0].error.message)||''),source:results[1].html,sourceError:results[1].error,editing:false,dirty:false,saving:false};
 renderReader();if(edit)beginEdit();return true;
}
function beginEdit(restored){
 if(!doc||!B.admin)return;if(!doc.apiReady){B.toast('Сервер редакций не подключён: положите manuals_editor_api.py рядом с app.py и перезапустите приложение (README_DEPLOY_RU, «Редактор методичек»).',true);return;}
 if(doc.editing)return;
 var body=restored?restored.html:doc.edition.revision?doc.edition.html:doc.source;
 if(body===null||body===undefined){if(!confirm('Этот файл нельзя редактировать как Word в браузере. Создать отдельную текстовую веб-редакцию? Исходный PDF/DOC не изменится.'))return;body='<h1>'+esc(doc.f.name.replace(/\.(docx?|pdf)$/i,''))+'</h1><p>Текст методички…</p>';}
 doc.revision=restored?restored.revision:doc.edition.revision;doc.editing=true;doc.dirty=!!restored;selection=null;shell();paper(body,true);
 notice('Вы редактируете веб-версию. Кнопка «Сохранить» публикует её на сервере; исходный Word/PDF остаётся без изменений.');
 if(restored)status('Черновик восстановлен · сохраните правки на сервере');
 if(window.ManualsV18)window.ManualsV18.reader(doc);
}
async function save(){
 if(!doc||!doc.editing||doc.saving)return;var current=doc,p=main.querySelector('#mw-paper'),value=clean(p.innerHTML);writeDraft();current.saving=true;p.contentEditable='false';toolbar();
 try {
  // Do not publish over a source file replaced in another window.
  var list=await http('/api/manuals'),actual=null;(list.manuals||[]).forEach(function(m){(m.files||[]).forEach(function(f){if(f.id===current.fid)actual=f;});});
  if(!actual)throw new Error('Исходный файл удалён. Скопируйте правки в новую методичку.');
  if(String(actual.ver||1)!==String(current.f.ver||1)){var changed=new Error('Исходный файл заменён в другом окне. Откройте актуальную версию и перенесите правки.');changed.status=409;throw changed;}
  var result=await http(endpoint(current.fid),{method:'PUT',headers:{'Content-Type':'application/json','X-CSRFToken':token()},body:JSON.stringify({html:value,title:current.f.name.replace(/\.(docx?|pdf)$/i,''),source_ver:String(current.f.ver||1),base_revision:current.revision})});
  if(!Number.isInteger(result.revision)||result.revision<1||typeof result.html!=='string')throw new Error('Сервер не подтвердил сохранение редакции');
  current.edition=result;current.revision=result.revision;current.dirty=false;p.innerHTML=clean(result.html);clearDraft(current.fid);notice('Редакция '+result.revision+' сохранена на сервере и доступна для чтения всем пользователям.');B.toast('Правки сохранены');
 }catch(e){current.dirty=true;notice(e.message,e.status===409?'warn':'err',button('Открыть актуальную','reload'));}
 finally{current.saving=false;p.contentEditable='true';toolbar();status(current.dirty?'Не сохранено · текст остаётся в редакторе':'Сохранено на сервере · редакция '+current.revision);}
}
function rememberSelection(){var p=main.querySelector('#mw-paper'),s=window.getSelection();if(s.rangeCount&&p&&p.contains(s.anchorNode))selection=s.getRangeAt(0).cloneRange();}
function command(name,value){var p=main.querySelector('#mw-paper');if(!p||!doc.editing||doc.saving)return;p.focus();if(selection){var sel=window.getSelection();sel.removeAllRanges();try{sel.addRange(selection);}catch(_){}}
 document.execCommand(name,false,value||null);rememberSelection();dirty();}
function insertImage(){var input=document.createElement('input');input.type='file';input.accept='image/png,image/jpeg,image/webp,image/gif';input.onchange=function(){var f=input.files[0];if(!f)return;if(!/^image\/(png|jpeg|webp|gif)$/.test(f.type)||f.size>3*1024*1024){B.toast('Выберите PNG/JPG/WebP/GIF не больше 3 МБ.',true);return;}var target=doc;var r=new FileReader();r.onload=function(){if(doc===target&&doc.editing)command('insertHTML','<p><img src="'+esc(r.result)+'" alt="Иллюстрация"></p><p><br></p>');};r.readAsDataURL(f);};input.click();}
async function showHistory(){if(!doc||!B.admin)return;var target=doc;try{var h=await http(endpoint(doc.fid)+'/history');if(doc!==target)return;if(!h.items.length){B.toast('Сохранённых редакций пока нет');return;}var n=prompt('Редакции (новые сверху):\n'+h.items.map(function(x){return x.revision+' — '+B.date(x.saved_at);}).join('\n')+'\n\nВведите номер для восстановления в редакторе:');if(n===null)return;if(!/^\d+$/.test(n.trim()))return;var old=await http(endpoint(doc.fid)+'/revisions/'+n.trim());if(doc!==target||!leave())return;doc.editing=false;doc.dirty=false;beginEdit({html:old.html,revision:doc.edition.revision});notice('Загружена редакция '+old.revision+'. Нажмите «Сохранить», чтобы опубликовать её как новую версию.','warn');}catch(e){B.toast(e.message,true);}}
function printEdition(){if(!doc||doc.editing)return;var frame=document.createElement('iframe');frame.hidden=true;document.body.appendChild(frame);frame.onload=function(){frame.contentWindow.focus();frame.contentWindow.print();setTimeout(function(){frame.remove();},60000);};frame.srcdoc='<!doctype html><meta charset="utf-8"><title>'+esc(doc.f.name)+'</title><style>body{font:12pt/1.5 Arial;padding:16px}img{max-width:100%;height:auto}table{border-collapse:collapse;max-width:100%}td,th{border:1px solid #bbb;padding:6px}@page{size:A4;margin:18mm}</style>'+clean(doc.edition.html);}
main.addEventListener('toggle',function(e){if(!e.target.classList.contains('mw-more')||!e.target.open)return;var menu=e.target.querySelector('.mw-more-menu');if(!menu)return;menu.style.left='';menu.style.right='0';if(window.innerWidth<=900){var r=e.target.getBoundingClientRect(),x=Math.max(16,Math.min(r.left,window.innerWidth-menu.offsetWidth-16));menu.style.left=(x-r.left)+'px';menu.style.right='auto';}},true);
main.addEventListener('mousedown',function(e){if(e.target.closest('[data-command]')){rememberSelection();e.preventDefault();}});
main.addEventListener('change',function(e){if(e.target.id==='mw-block')command('formatBlock',e.target.value);});
main.addEventListener('click',async function(e){
 if(doc&&!doc.editing){var image=e.target.closest('.mw-paper img');if(image){var lb=document.getElementById('lb');lb.querySelector('img').src=image.src;lb.classList.add('on');return;}}
 var edit=e.target.closest('[data-open-edit]');if(edit){var fid=edit.getAttribute('data-open-edit');e.preventDefault();historyReplace(fid);await open(fid,false,true);return;}
 var cmd=e.target.closest('[data-command]');if(cmd){var c=cmd.getAttribute('data-command');if(c==='link'){var u=prompt('Адрес ссылки (https://…)');if(u&&urlSafe(u,false))command('createLink',u);else if(u)B.toast('Недопустимый адрес ссылки',true);}else if(c==='image')insertImage();else if(c==='table')command('insertHTML','<table><tbody>'+Array(3).fill('<tr><td>Текст</td><td>Текст</td><td>Текст</td></tr>').join('')+'</tbody></table><p><br></p>');else command(c);return;}
 var a=e.target.closest('[data-ws]');if(!a)return;e.preventDefault();var action=a.getAttribute('data-ws');
 if(action==='save')save();else if(action==='edit')beginEdit();else if(action==='home'){if(!leave())return;main.classList.remove('full');doc=null;location.hash='';home();}
 else if(action==='cancel'){if(!leave())return;doc.editing=false;doc.dirty=false;renderReader();}
 else if(action==='replace')B.replace(doc.fid);else if(action==='rename')B.rename(doc.fid);else if(action==='delete')B.remove(doc.fid);else if(action==='history')showHistory();else if(action==='print')printEdition();
 else if(action==='full'){main.classList.toggle('full');toolbar();}
 else if(action==='reload')open(doc.fid,true);
 else if(action==='restore-draft'){var d=getDraft(doc.fid);if(d)beginEdit(d);}
 else if(action==='delete-draft'){clearDraft(doc.fid);notice('Черновик удалён. Сохранённая редакция не менялась.');}
});
function historyReplace(fid){window.history.replaceState(null,'','#f='+encodeURIComponent(fid));}
window.addEventListener('beforeunload',function(e){if(doc&&(doc.dirty||doc.saving)){writeDraft();e.preventDefault();e.returnValue='';}});
document.addEventListener('keydown',function(e){if(e.key==='Escape'){document.getElementById('lb').classList.remove('on');main.querySelectorAll('.mw-more[open]').forEach(function(d){d.open=false;});}if(doc&&doc.editing&&(e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();save();}});
var wasMobile=window.innerWidth<=900;window.addEventListener('resize',function(){var mobile=window.innerWidth<=900;if(mobile!==wasMobile){var f=main.querySelector('.mw-format');if(f)f.open=!mobile;wasMobile=mobile;}});
var narrow=window.matchMedia('(max-width:900px)');if(narrow.addEventListener)narrow.addEventListener('change',function(e){var f=main.querySelector('.mw-format');if(f)f.open=!e.matches;});
window.ManualsWorkspace={open:open,home:home,toolbar:toolbar,current:function(){return doc;}};
// The base template starts its initial fetch before this script loads. Repaint only if it already completed.
if(S.manuals.length){var initial=location.hash.match(/f=([a-zA-Z0-9_-]+)/);if(initial)open(initial[1]);else home();}
})();
