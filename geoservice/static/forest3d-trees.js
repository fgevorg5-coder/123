/* forest3d-trees.js — реалистичные 3D-модели деревьев для режима 3D (v20).
 *
 * Модели: ez-tree 1.1.0 (MIT, © 2024 Daniel Greenheck), сгенерированы офлайн (tools/trees/gen.py или gen.js):
 * сосна, ель, берёза, осина, дуб, прочие лиственные — по 3 варианта формы кроны (v20: кроны в 1,5–2 раза гуще,
 * ель — плотный конус до земли, сосна — крона в верхней трети, берёза — белый ствол и светлая листва летнего цвета,
 * осина — серо-зелёная). Геометрия квантована (trees_v20.bin),
 * атлас импосторов (impostors_v20.webp) отрисован из тех же моделей при том же освещении, что и сцена.
 * Текстуры коры — Poly Haven / TextureCan (CC0), листвы и хвои — из ez-tree (MIT).
 *
 * Отрисовка одного слоя деревьев:
 *   • дальние деревья — импосторы: 2 скрещённые вертикальные плоскости + «вид сверху» (один InstancedMesh на модель);
 *   • ближние (не более nearMax в радиусе nearRadius от камеры) — полные модели: ветви с корой + листва/хвоя;
 *   • граница ближних/дальних — порог uNear от точки uNearCam: импостор скрывается в вершинном шейдере, а набор
 *     ближних деревьев на CPU выбирается по тому же порогу — без «двойников» и пропусков.
 * Режим «по породам»: цвет листвы = цвет породы × яркость текстуры (форма и светотень сохраняются).
 */
(function () {
    'use strict';
    var VER = 'v20', BASE = '/static/forest3d/trees/', LS_Q = 'forest3d_trees_q';
    var CFG = { nearRadius: 220, nearMax: 380, alphaTest: 0.5, moveStep: 4, minInterval: 110 };
    var S = { lib: null, promise: null, error: null, T: null };
    try {   // слабые устройства: меньше полных моделей вблизи
        var mob = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent || '') || (navigator.hardwareConcurrency || 8) <= 2;
        if (mob) { CFG.nearMax = 170; CFG.nearRadius = 150; }   // v20: модели детальнее (до ~7,7 тыс. треугольников)
    } catch (_) {}

    // порода ЛесоЛидара (id) → модель; хвойные/лиственные не смешиваются (тип дерева в данных главнее)
    var MODEL_BY_SPECIES = { 1: 'pine', 2: 'spruce', 3: 'pine', 11: 'birch', 12: 'aspen', 13: 'decid', 14: 'aspen', 15: 'oak', 16: 'oak', 17: 'decid' };
    var SPECIES_TINT = { 3: [1.03, 1.09, 0.80] };   // лиственница: хвоя светлее
    var CONIFER_MODELS = { pine: 1, spruce: 1 };

    function hash01(k, s) {
        var x = Math.imul((k + 1) ^ s, 0x85ebca6b); x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); x ^= x >>> 16;
        return (x >>> 0) / 4294967296;
    }
    function quality(v) {
        if (v === 'real' || v === 'simple') { try { localStorage.setItem(LS_Q, v); } catch (_) {} return v; }
        var q = null; try { q = localStorage.getItem(LS_Q); } catch (_) {}
        return q === 'simple' ? 'simple' : 'real';
    }
    function supported(renderer) {
        try { var c = renderer && renderer.capabilities; return !c || ((c.maxTextureSize || 4096) >= 2048 && (c.maxVertexUniforms || 1024) >= 128); }
        catch (_) { return false; }
    }

    // ── декодирование квантованной геометрии ──
    function decodeGeom(T, buf, g) {
        var nv = g.nv, i, a, pos = new Float32Array(nv * 3), qp = new Int16Array(buf, g.pos[0], nv * 3);
        for (a = 0; a < 3; a++) { var mn = g.min[a], r = (g.max[a] - g.min[a]) || 1; for (i = a; i < nv * 3; i += 3) pos[i] = (qp[i] + 32767) / 65534 * r + mn; }
        var qn = new Int8Array(buf, g.nrm[0], nv * 4), nrm = new Float32Array(nv * 3);
        for (i = 0; i < nv; i++) {
            var x = qn[i * 4] / 127, y = qn[i * 4 + 1] / 127, z = qn[i * 4 + 2] / 127, l = Math.sqrt(x * x + y * y + z * z) || 1;
            nrm[i * 3] = x / l; nrm[i * 3 + 1] = y / l; nrm[i * 3 + 2] = z / l;
        }
        var qu = new Int16Array(buf, g.uv[0], nv * 2), uv = new Float32Array(nv * 2), us = g.uvScale || 1;
        for (i = 0; i < nv * 2; i++) uv[i] = qu[i] / 32767 * us;
        var geo = new T.BufferGeometry();
        geo.setAttribute('position', new T.BufferAttribute(pos, 3));
        geo.setAttribute('normal', new T.BufferAttribute(nrm, 3));
        geo.setAttribute('uv', new T.BufferAttribute(uv, 2));
        geo.setIndex(new T.BufferAttribute(new Uint16Array(buf, g.idx[0], g.ni).slice(), 1));
        geo.computeBoundingSphere();
        return geo;
    }
    // импостор: 2 вертикальные плоскости (вид сбоку) + горизонтальная (вид сверху) с UV в общем атласе
    function impostorGeom(T, m, at) {
        var W = at.width, H = at.height, SW = at.sideW, SH = at.sideH, TW = at.topW, TOPY = at.rows * SH;
        var w = m.imp.wHalf, top = m.imp.top, bot = m.imp.bottom, col = m.imp.col, row = m.imp.row;
        var u0 = (col * SW + 0.5) / W, u1 = ((col + 1) * SW - 0.5) / W, vT = 1 - (row * SH + 0.5) / H, vB = 1 - ((row + 1) * SH - 0.5) / H;
        var tu0 = (col * TW + 0.5) / W, tu1 = ((col + 1) * TW - 0.5) / W, tvN = 1 - (TOPY + row * TW + 0.5) / H, tvS = 1 - (TOPY + (row + 1) * TW - 0.5) / H;
        var yTop = m.crownBase + (1 - m.crownBase) * 0.55;
        var P = [-w, bot, 0, w, bot, 0, w, top, 0, -w, top, 0,
            0, bot, w, 0, bot, -w, 0, top, -w, 0, top, w,
            -w, yTop, w, w, yTop, w, w, yTop, -w, -w, yTop, -w];
        var U = [u0, vB, u1, vB, u1, vT, u0, vT, u0, vB, u1, vB, u1, vT, u0, vT, tu0, tvS, tu1, tvS, tu1, tvN, tu0, tvN];
        var N = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0];
        var geo = new T.BufferGeometry();
        geo.setAttribute('position', new T.BufferAttribute(new Float32Array(P), 3));
        geo.setAttribute('normal', new T.BufferAttribute(new Float32Array(N), 3));
        geo.setAttribute('uv', new T.BufferAttribute(new Float32Array(U), 2));
        geo.setAttribute('aTop', new T.BufferAttribute(new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1]), 1));   // v20: «вид сверху»
        geo.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11]);
        geo.computeBoundingSphere();
        return geo;
    }
    // средняя линейная яркость непрозрачных пикселей (нормировка цвета породы в режиме легенды)
    function avgLum(img, tint, rect) {
        try {
            var cv = document.createElement('canvas'), S2 = 64; cv.width = S2; cv.height = S2;
            var x = cv.getContext('2d', { willReadFrequently: true });
            if (rect) x.drawImage(img, rect[0], rect[1], rect[2], rect[3], 0, 0, S2, S2); else x.drawImage(img, 0, 0, S2, S2);
            var d = x.getImageData(0, 0, S2, S2).data, s = 0, n = 0;
            var lin = function (c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
            for (var i = 0; i < d.length; i += 4) if (d[i + 3] >= 128) { s += 0.2126 * lin(d[i]) * tint.r + 0.7152 * lin(d[i + 1]) * tint.g + 0.0722 * lin(d[i + 2]) * tint.b; n++; }
            return n ? s / n : 0.1;
        } catch (_) { return 0.1; }
    }
    var MIP_ALPHA = [
        '#if defined( USE_MAP ) && __VERSION__ >= 300',
        '{ vec2 f3q = vMapUv * vec2( textureSize( map, 0 ) ); vec2 f3x = dFdx( f3q ), f3y = dFdy( f3q );',
        '  float f3l = 0.5 * log2( max( max( dot( f3x, f3x ), dot( f3y, f3y ) ), 1e-8 ) );',
        '  diffuseColor.a *= 1.0 + max( 0.0, f3l ) * 0.25; }',   // мипмапы не «съедают» листву вдали
        '#endif',
        'float f3dLum = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );'].join('\n');
    var LEGEND = [
        '#if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )',
        'if ( uLegend > 0.5 ) diffuseColor.rgb = vColor * clamp( f3dLum * uGain, 0.2, 1.8 );',
        '#endif'].join('\n');
    function patch(mat, kind, U) {
        mat.onBeforeCompile = function (sh) {
            sh.uniforms.uLegend = U.legend; sh.uniforms.uGain = U.gain;
            if (kind === 'imp') {
                sh.uniforms.uNear = U.near; sh.uniforms.uNearCam = U.cam;
                // v20: плоскость «вид сверху» скрывается при пологом взгляде (< ~25°) — без горизонтальной «полосы» поперёк кроны
                sh.vertexShader = 'uniform float uNear;\nuniform vec3 uNearCam;\nattribute float aTop;\n' + sh.vertexShader.replace('#include <begin_vertex>',
                    '#include <begin_vertex>\n#ifdef USE_INSTANCING\n{ vec3 f3c = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.5, 0.0, 1.0 ) ).xyz;\n' +
                    'if ( distance( f3c, uNearCam ) < uNear ) transformed = vec3( 0.0 );\nelse if ( aTop > 0.5 && normalize( uNearCam - f3c ).y < 0.42 ) transformed = vec3( 0.0 ); }\n#endif');
            }
            sh.fragmentShader = 'uniform float uLegend;\nuniform float uGain;\n' + sh.fragmentShader
                .replace('#include <map_fragment>', '#include <map_fragment>\n' + MIP_ALPHA)
                .replace('#include <color_fragment>', '#include <color_fragment>\n' + LEGEND);
        };
        mat.customProgramCacheKey = function () { return 'f3dtrees-' + kind + '-' + VER; };
        return mat;
    }

    function okJson(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }
    function okBuf(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); }
    function load(T, opts) {
        opts = opts || {};
        if (S.lib) { if (opts.anisotropy) setAniso(opts.anisotropy); return Promise.resolve(S.lib); }
        if (S.promise) return S.promise;
        var q = '?v=' + VER;
        S.T = T; S.error = null;
        S.promise = Promise.all([
            fetch(BASE + 'trees_' + VER + '.json' + q, { credentials: 'same-origin' }).then(okJson),
            fetch(BASE + 'trees_' + VER + '.bin' + q, { credentials: 'same-origin' }).then(okBuf)
        ]).then(function (r) {
            var meta = r[0], buf = r[1], loader = new T.TextureLoader(), tex = {}, jobs = [];
            function get(name, repeat) {
                jobs.push(loader.loadAsync(BASE + name + q).then(function (t) {
                    t.colorSpace = T.SRGBColorSpace;
                    if (repeat) { t.wrapS = t.wrapT = T.RepeatWrapping; }
                    tex[name] = t;
                }));
            }
            get(meta.atlas.file, false);
            var barks = {}, leaves = {};
            meta.models.forEach(function (m) { barks[m.bark] = 1; leaves[m.leaf] = 1; });
            Object.keys(barks).forEach(function (b) { get('bark_' + b + '.jpg', true); });
            Object.keys(leaves).forEach(function (l) { get('leaves_' + l + '.webp', false); });
            return Promise.all(jobs).then(function () { return build(T, meta, buf, tex); });
        }).then(function (lib) {
            S.lib = lib; S.error = null; if (opts.anisotropy) setAniso(opts.anisotropy); return lib;
        }).catch(function (e) { S.promise = null; S.error = e; throw e; });
        return S.promise;
    }
    function setAniso(a) {
        var L = S.lib; if (!L || !a || L.aniso === a) return; L.aniso = a;
        L.textures.forEach(function (t) { t.anisotropy = a; t.needsUpdate = true; });
    }
    function build(T, meta, buf, tex) {
        var at = meta.atlas, atlas = tex[at.file], barkCache = {}, all = [atlas];
        var lib = { T: T, meta: meta, atlas: atlas, models: [], bySpecies: {}, textures: all, aniso: 0, tris: 0 };
        meta.models.forEach(function (m, i) {
            var bk = m.bark + ':' + (m.barkRepeat || [1, 1]).join(',');
            var bt = barkCache[bk];
            if (!bt) {
                bt = barkCache[bk] = tex['bark_' + m.bark + '.jpg'].clone();
                bt.repeat.set((m.barkRepeat || [1, 1])[0], (m.barkRepeat || [1, 1])[1]); bt.needsUpdate = true; all.push(bt);
            }
            var lt = tex['leaves_' + m.leaf + '.webp']; if (all.indexOf(lt) < 0) all.push(lt);
            var leafTint = new T.Color(m.leafTint);
            var rec = {
                i: i, key: m.key, species: m.species, conifer: !!CONIFER_MODELS[m.species], m: m, tris: m.tris,
                branches: decodeGeom(T, buf, m.branches), leaves: decodeGeom(T, buf, m.leaves), imp: impostorGeom(T, m, at),
                matBark: new T.MeshLambertMaterial({ map: bt, color: new T.Color(m.barkTint) }),
                leafMap: lt, leafTint: leafTint,
                gain: Math.max(1, Math.min(40, 0.92 / avgLum(lt.image, leafTint)))
            };
            lib.models.push(rec);
            (lib.bySpecies[m.species] = lib.bySpecies[m.species] || []).push(i);
        });
        return lib;
    }
    function modelKey(type, sid, k) {
        var key = MODEL_BY_SPECIES[sid], con = type === 1;
        if (key && !!CONIFER_MODELS[key] === con) return key;
        var r = hash01(k, 0x51ed27);
        if (con) return r < 0.65 ? 'pine' : 'spruce';
        return r < 0.45 ? 'birch' : r < 0.70 ? 'aspen' : 'decid';
    }
    function pickModel(lib, type, sid, k) {
        var v = lib.bySpecies[modelKey(type, sid, k)] || lib.bySpecies[type === 1 ? 'pine' : 'birch'] || [0];
        return v[Math.floor(hash01(k, 0x2545f491) * v.length) % v.length];
    }

    /* Слой реалистичных деревьев.
     * o: { arr (Float32Array, 7 чисел на дерево: x, y, h, dbh, d кроны, h кроны, тип), n, step, species (Uint8Array|null),
     *      colors ({id: '#rrggbb'}|null), colorMode ('natural'|'legend'), scene, cx, cy, ground(x, y), grid (Map), CS, requestRender(ms) } */
    function createLayer(o) {
        var lib = S.lib; if (!lib) throw new Error('Модели деревьев не загружены');
        var T = lib.T, arr = o.arr, n = o.n, step = o.step || 1, sp = o.species || null, NM = lib.models.length;
        var group = new T.Group(); group.name = 'forest3d-trees-real';
        var modelOf = new Uint8Array(n), slotOf = new Int32Array(n), refY = new Float32Array(n), counts = new Int32Array(NM), k, mi;
        for (k = 0; k < n; k += step) {
            mi = pickModel(lib, (arr[k * 7 + 6] % 10) === 1 ? 1 : 2, sp ? sp[k] : 0, k);
            modelOf[k] = mi; slotOf[k] = counts[mi]++;
        }
        var U = { near: { value: 0 }, cam: { value: new T.Vector3(0, -1e7, 0) }, legend: { value: 0 } };
        var M = [], mats = [];
        for (mi = 0; mi < NM; mi++) {
            var c = counts[mi]; if (!c) { M.push(null); continue; }
            var L = lib.models[mi], Ug = { near: U.near, cam: U.cam, legend: U.legend, gain: { value: L.gain } };
            var mImp = patch(new T.MeshBasicMaterial({ map: lib.atlas, alphaTest: CFG.alphaTest, side: T.DoubleSide }), 'imp', Ug);
            var mLeaf = patch(new T.MeshLambertMaterial({ map: L.leafMap, color: L.leafTint, alphaTest: CFG.alphaTest, side: T.DoubleSide }), 'leaf', Ug);
            mats.push(mImp, mLeaf);
            var imp = new T.InstancedMesh(L.imp, mImp, c);
            imp.instanceColor = new T.InstancedBufferAttribute(new Float32Array(c * 3), 3);
            var cap = Math.min(c, CFG.nearMax);
            var nb = new T.InstancedMesh(L.branches, L.matBark, cap), nl = new T.InstancedMesh(L.leaves, mLeaf, cap);
            nb.instanceColor = new T.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
            nl.instanceColor = new T.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
            [imp, nb, nl].forEach(function (m) { m.frustumCulled = false; m.matrixAutoUpdate = false; group.add(m); });
            nb.count = nl.count = 0; nb.visible = nl.visible = false;
            M.push({ imp: imp, nb: nb, nl: nl, n: c, cap: cap, conifer: L.conifer, L: L, ids: new Int32Array(c), show: true, near: 0, sig: 0 });
        }
        for (k = 0; k < n; k += step) M[modelOf[k]].ids[slotOf[k]] = k;
        o.scene.add(group);

        var colors = o.colors || null, legend = o.colorMode === 'legend' && !!colors, colCache = {}, vis = true, dirty = true;
        var last = new T.Vector3(1e9, 1e9, 1e9), lastT = 0, minRef = Infinity, maxRef = -Infinity, nearTotal = 0, nearTris = 0, thr = 0;
        function speciesColor(sid) {
            if (!colors || colors[sid] == null) return null;
            return colCache[sid] || (colCache[sid] = new T.Color(colors[sid]));
        }
        function paint() {
            U.legend.value = legend ? 1 : 0;
            for (var mi2 = 0; mi2 < NM; mi2++) {
                var E = M[mi2]; if (!E) continue;
                var C = E.imp.instanceColor.array;
                for (var j = 0; j < E.n; j++) {
                    var kk = E.ids[j], v = 0.86 + 0.2 * hash01(kk, 0x1b873593), w = hash01(kk, 0x0cc9e2d5) - 0.5, r = v * (1 + w * 0.07), g = v, b = v * (1 - w * 0.09);
                    var sid = sp ? sp[kk] : 0;
                    if (legend) { var sc2 = speciesColor(sid); if (sc2) { r = sc2.r * (0.9 + 0.2 * (v - 0.86) / 0.2); g = sc2.g * (0.9 + 0.2 * (v - 0.86) / 0.2); b = sc2.b * (0.9 + 0.2 * (v - 0.86) / 0.2); } }
                    else if (SPECIES_TINT[sid]) { var tt = SPECIES_TINT[sid]; r *= tt[0]; g *= tt[1]; b *= tt[2]; }
                    C[j * 3] = r; C[j * 3 + 1] = g; C[j * 3 + 2] = b;
                }
                E.imp.instanceColor.needsUpdate = true; E.sig = -1;
            }
            dirty = true;
        }
        function update(baseArr) {   // положение/масштаб всех деревьев (после изменения рельефа)
            minRef = Infinity; maxRef = -Infinity;
            for (var mi2 = 0; mi2 < NM; mi2++) {
                var E = M[mi2]; if (!E) continue;
                var A = E.imp.instanceMatrix.array, mm = E.L.m, cr = mm.crownR || 0.25, trR = mm.trunkR || 0.015;
                for (var j = 0; j < E.n; j++) {
                    var kk = E.ids[j], x = arr[kk * 7] - o.cx, yN = arr[kk * 7 + 1] - o.cy;
                    var h = Math.max(0.4, arr[kk * 7 + 2]), R = arr[kk * 7 + 4] / 2;
                    var s = R > 0.05 ? R / cr : h; if (s < 0.6 * h) s = 0.6 * h; else if (s > 1.6 * h) s = 1.6 * h;
                    var b0 = baseArr[kk], rr = Math.max(0.12, trR * s);
                    var root = Math.min(b0, o.ground(x - rr, yN), o.ground(x + rr, yN), o.ground(x, yN - rr), o.ground(x, yN + rr)) - Math.min(0.25, 0.05 + rr * 0.3);
                    var ang = hash01(kk, 0x68e31da4) * 6.283185307, ca = Math.cos(ang), sa = Math.sin(ang), q = j * 16;
                    A[q] = s * ca; A[q + 1] = 0; A[q + 2] = -s * sa; A[q + 3] = 0;
                    A[q + 4] = 0; A[q + 5] = h; A[q + 6] = 0; A[q + 7] = 0;
                    A[q + 8] = s * sa; A[q + 9] = 0; A[q + 10] = s * ca; A[q + 11] = 0;
                    A[q + 12] = x; A[q + 13] = root; A[q + 14] = -yN; A[q + 15] = 1;
                    var ry = root + 0.5 * h; refY[kk] = ry; if (ry < minRef) minRef = ry; if (ry > maxRef) maxRef = ry;
                }
                E.imp.instanceMatrix.needsUpdate = true; E.sig = -1;
            }
            dirty = true;
        }
        var cK = new Int32Array(1024), cD = new Float32Array(1024), hist = new Int32Array(128), used = new Int32Array(NM);
        function lod(cam, force) {   // ближние деревья → полные модели; вызывается каждый кадр, работает только при движении камеры
            var p = cam.position, now = performance.now();
            if (!force && !dirty) {
                var ddx = p.x - last.x, ddy = p.y - last.y, ddz = p.z - last.z;
                if (ddx * ddx + ddy * ddy + ddz * ddz < CFG.moveStep * CFG.moveStep) return false;
                if (now - lastT < CFG.minInterval) return false;
            }
            dirty = false; last.copy(p); lastT = now;
            var Rn = CFG.nearRadius, R2 = Rn * Rn, cnt = 0, CS = o.CS, grid = o.grid;
            if (vis && p.y - maxRef < Rn && minRef - p.y < Rn) {
                var gx0 = Math.floor((p.x - Rn) / CS), gx1 = Math.floor((p.x + Rn) / CS), gy0 = Math.floor((-p.z - Rn) / CS), gy1 = Math.floor((-p.z + Rn) / CS);
                for (var gx = gx0; gx <= gx1; gx++) for (var gy = gy0; gy <= gy1; gy++) {
                    var b = grid.get(gx * 100003 + gy); if (!b) continue;
                    for (var q = 0; q < b.length; q++) {
                        var kk = b[q], E0 = M[modelOf[kk]]; if (!E0 || !E0.show) continue;
                        var dx = arr[kk * 7] - o.cx - p.x, dz = -(arr[kk * 7 + 1] - o.cy) - p.z, dy = refY[kk] - p.y, d2 = dx * dx + dy * dy + dz * dz;
                        if (d2 >= R2) continue;
                        if (cnt >= cK.length) { var nk = new Int32Array(cK.length * 2), nd = new Float32Array(cK.length * 2); nk.set(cK); nd.set(cD); cK = nk; cD = nd; }
                        cK[cnt] = kk; cD[cnt] = Math.sqrt(d2); cnt++;
                    }
                }
            }
            var NMAX = CFG.nearMax, sel = cnt, T0 = Rn, i2;
            if (cnt > NMAX) {   // порог по гистограмме расстояний + точная граница в пограничной корзине
                hist.fill(0); var NB = hist.length, bw = Rn / NB;
                for (i2 = 0; i2 < cnt; i2++) hist[Math.min(NB - 1, Math.floor(cD[i2] / bw))]++;
                var acc = 0, bi = 0; while (bi < NB && acc + hist[bi] <= NMAX) { acc += hist[bi]; bi++; }
                var lo = bi * bw, hi = lo + bw, edge = [];
                for (i2 = 0; i2 < cnt; i2++) if (cD[i2] >= lo && cD[i2] < hi) edge.push(cD[i2]);
                edge.sort(function (a, c) { return a - c; });
                var need = NMAX - acc;
                var dIn = need > 0 ? edge[need - 1] : -1, dOut = edge[need];
                if (dIn < 0) { dIn = 0; for (i2 = 0; i2 < cnt; i2++) if (cD[i2] < lo && cD[i2] > dIn) dIn = cD[i2]; }
                T0 = (dIn + dOut) / 2; if (!(T0 > dIn)) T0 = dIn + 1e-4;
                sel = 0;
            }
            used.fill(0); var sig = new Int32Array(NM), cnt2 = 0;
            for (i2 = 0; i2 < cnt; i2++) {
                if (cD[i2] >= T0) continue;
                var k2 = cK[i2], m2 = modelOf[k2], E = M[m2], j2 = used[m2];
                if (j2 >= E.cap) continue;
                used[m2] = j2 + 1; cnt2++;
                sig[m2] = (Math.imul(sig[m2], 31) + k2 + 1) | 0;
                var src = E.imp.instanceMatrix.array, s0 = slotOf[k2] * 16, dB = E.nb.instanceMatrix.array, dL = E.nl.instanceMatrix.array, d0 = j2 * 16;
                for (var e = 0; e < 16; e++) { dB[d0 + e] = src[s0 + e]; dL[d0 + e] = src[s0 + e]; }
                var cs = E.imp.instanceColor.array, cl = E.nl.instanceColor.array, cb = E.nb.instanceColor.array, c3 = slotOf[k2] * 3, t3 = j2 * 3;
                cl[t3] = cs[c3]; cl[t3 + 1] = cs[c3 + 1]; cl[t3 + 2] = cs[c3 + 2];
                var vb = 0.82 + 0.3 * hash01(k2, 0x1b873593); cb[t3] = vb; cb[t3 + 1] = vb; cb[t3 + 2] = vb;
            }
            nearTotal = 0; nearTris = 0;
            for (var m3 = 0; m3 < NM; m3++) {
                var E3 = M[m3]; if (!E3) continue;
                var nc = used[m3], s3 = (Math.imul(sig[m3], 7) + nc) | 0;
                if (s3 !== E3.sig || nc !== E3.near) {
                    E3.nb.count = E3.nl.count = nc; E3.near = nc; E3.sig = s3;
                    E3.nb.instanceMatrix.needsUpdate = E3.nl.instanceMatrix.needsUpdate = true;
                    E3.nb.instanceColor.needsUpdate = E3.nl.instanceColor.needsUpdate = true;
                }
                E3.nb.visible = E3.nl.visible = vis && E3.show && nc > 0;
                nearTotal += nc; nearTris += nc * E3.L.tris;
            }
            thr = cnt2 ? T0 : 0;
            U.near.value = thr; U.cam.value.copy(p);
            if (o.requestRender) o.requestRender(200);
            return true;
        }
        function setVisible(v, filter) {
            vis = !!v; group.visible = vis;
            for (var mi2 = 0; mi2 < NM; mi2++) {
                var E = M[mi2]; if (!E) continue;
                E.show = !filter || !!filter[E.conifer ? 1 : 2];
                E.imp.visible = vis && E.show; E.nb.visible = E.nl.visible = vis && E.show && E.near > 0;
            }
            dirty = true;
        }
        function recolor(c2, mode) { colors = c2 || null; legend = mode === 'legend' && !!colors; colCache = {}; paint(); }
        function dispose() {
            o.scene.remove(group);
            group.children.forEach(function (m) { if (m.dispose) m.dispose(); });
            mats.forEach(function (m) { m.dispose(); });
            M = []; NM = 0;
        }
        function stats() {
            var imp = 0; M.forEach(function (E) { if (E) imp += E.n; });
            return { impostors: imp, near: nearTotal, nearTris: nearTris, threshold: +thr.toFixed(2), models: M.filter(Boolean).length, nearMax: CFG.nearMax, nearRadius: CFG.nearRadius };
        }
        paint();
        return { group: group, update: update, lod: lod, setVisible: setVisible, recolor: recolor, dispose: dispose, stats: stats };
    }

    window.Forest3DTrees = {
        version: VER, config: CFG, quality: quality, supported: supported, load: load, modelKey: modelKey,
        lib: function () { return S.lib; }, error: function () { return S.error; }, loading: function () { return !!S.promise && !S.lib; },
        createLayer: createLayer
    };
})();
