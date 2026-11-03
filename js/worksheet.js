/**
 * MyLKPD worksheet editor.
 *
 * Shows the worksheet (PDF via PDF.js, or DOCX via docx-preview). Two ways of working:
 *  - annotate: put answers on top of each page (text, tick, cross, circle, highlight, line, pen,
 *    move, eraser, undo). Positions are percentages of the page, so they fit any screen size.
 *  - edit: type directly into the paragraphs and table cells of a .docx worksheet.
 * Work is autosaved through ajax.php. For group work the page also syncs every few seconds, shows
 * who is online, and locks a paragraph while a group mate is typing in it.
 *
 * @package    mod_mylkpd
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
var MyLKPD = (function() {
    'use strict';

    var SVGNS = 'http://www.w3.org/2000/svg';
    var MAX_UNDO = 50;

    // ---------------------------------------------------------------- Library loading.
    // Moodle pages use RequireJS. The UMD builds of PDF.js, JSZip and docx-preview then register
    // as AMD modules instead of globals, so they must be loaded through require().

    function hasAmd() {
        return typeof window.require === 'function' && typeof window.define === 'function' && window.define.amd;
    }

    function loadScript(src) {
        return new Promise(function(resolve, reject) {
            var s = document.createElement('script');
            s.src = src;
            s.onload = resolve;
            s.onerror = function() {
                reject(new Error('Cannot load ' + src));
            };
            document.head.appendChild(s);
        });
    }

    function amd(paths, name) {
        return new Promise(function(resolve, reject) {
            window.require.config({paths: paths});
            window.require([name], resolve, reject);
        });
    }

    function loadPdfjs(base) {
        if (window.pdfjsLib) {
            return Promise.resolve(window.pdfjsLib);
        }
        if (hasAmd()) {
            return amd({'pdfjs-dist/build/pdf': base + '/pdf.min'}, 'pdfjs-dist/build/pdf');
        }
        return loadScript(base + '/pdf.min.js').then(function() {
            return window.pdfjsLib;
        });
    }

    function loadDocx(base) {
        if (window.docx && window.docx.renderAsync) {
            return Promise.resolve(window.docx);
        }
        if (hasAmd()) {
            return amd({'jszip': base + '/jszip.min', 'mylkpd-docx-preview': base + '/docx-preview.min'},
                'mylkpd-docx-preview');
        }
        return loadScript(base + '/jszip.min.js').then(function() {
            return loadScript(base + '/docx-preview.min.js');
        }).then(function() {
            return window.docx;
        });
    }

    var katexPromise = null;

    function loadKatex(base) {
        if (katexPromise) {
            return katexPromise;
        }
        if (!document.querySelector('link[data-mylkpd-katex]')) {
            var css = document.createElement('link');
            css.rel = 'stylesheet';
            css.href = base + '/katex.min.css';
            css.setAttribute('data-mylkpd-katex', '1');
            document.head.appendChild(css);
        }
        if (window.katex) {
            katexPromise = Promise.resolve(window.katex);
        } else if (hasAmd()) {
            katexPromise = amd({'mylkpd-katex': base + '/katex.min'}, 'mylkpd-katex');
        } else {
            katexPromise = loadScript(base + '/katex.min.js').then(function() {
                return window.katex;
            });
        }
        return katexPromise;
    }

    // ---------------------------------------------------------------- Helpers.

    function clamp(v) {
        return Math.max(0, Math.min(100, Math.round(v * 100) / 100));
    }

    function svgEl(name, attrs) {
        var el = document.createElementNS(SVGNS, name);
        Object.keys(attrs).forEach(function(k) {
            el.setAttribute(k, attrs[k]);
        });
        return el;
    }

    function closestItem(node) {
        while (node && node.nodeType === 1) {
            if (node.classList && node.classList.contains('mylkpd-item')) {
                return node;
            }
            node = node.parentNode;
        }
        return null;
    }

    function grow(ta) {
        var longest = ta.value.split('\n').reduce(function(m, l) {
            return Math.max(m, l.length);
        }, 0);
        ta.style.width = Math.max(4, longest + 2) + 'ch';
        ta.style.height = 'auto';
        ta.style.height = ta.scrollHeight + 'px';
    }

    // ---------------------------------------------------------------- Editor.

    function copy(o) {
        return JSON.parse(JSON.stringify(o));
    }

    /**
     * Item without bookkeeping fields, as a stable string (sorted keys) for comparisons.
     *
     * @param {Object} it
     * @return {String}
     */
    function canon(it) {
        var o = {};
        Object.keys(it).forEach(function(k) {
            if (k !== 'v' && k !== 'by' && k !== 'id') {
                o[k] = it[k];
            }
        });
        return JSON.stringify(o, Object.keys(o).sort());
    }

    function strip(it) {
        var o = {};
        Object.keys(it).forEach(function(k) {
            if (k !== 'v' && k !== 'by' && k !== 'id') {
                o[k] = it[k];
            }
        });
        return o;
    }

    function init(cfg) {
        var container = document.getElementById(cfg.containerId);
        if (!container) {
            return;
        }
        var readonly = !!cfg.readonly;
        var canType = !!cfg.canType;
        var katex = null;
        var prevTool = null;
        var lastTarget = null;
        var savedRange = null;
        var hintEl = document.querySelector('[data-mylkpd-hint]');
        var hintText = hintEl ? hintEl.textContent : '';
        var members = cfg.members || {};
        var items = Array.isArray(cfg.items) ? cfg.items.filter(function(a) {
            return a && typeof a === 'object' && a.page && a.id;
        }) : [];
        var pages = {};
        var elems = new Map();
        var labels = new Map();
        var owners = new WeakMap();
        var showNames = !!cfg.showNames;
        var undoStack = [];
        var tool = cfg.defaultTool || 'text';
        var color = (cfg.colors && cfg.colors[0]) || '#1a47b8';
        var width = 4;

        // Sync state.
        var rev = cfg.rev || 0;
        var shadowItems = {};
        var shadowBlocks = {};
        var blockEls = {};
        var touched = {};
        var outbox = [];
        var inflight = null;
        var again = false;
        var saveTimer = null;
        var currentBlock = '';
        var failed = false;
        var lastError = '';
        var stateEl = document.getElementById('mylkpd-savestate');
        var presenceEl = document.getElementById('mylkpd-presence');

        items.forEach(function(it) {
            shadowItems[it.id] = canon(it);
        });

        function newId() {
            return cfg.userid + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        }

        function memberName(uid) {
            if (uid === cfg.userid) {
                return cfg.strings.you;
            }
            return members[uid] ? members[uid].name : '';
        }

        function setState(key) {
            if (!stateEl) {
                return;
            }
            var text = key ? cfg.strings[key] : '';
            if (key === 'saved') {
                var now = new Date();
                var hm = ('0' + now.getHours()).slice(-2) + ':' + ('0' + now.getMinutes()).slice(-2);
                text = cfg.strings.savedat.replace('{time}', hm);
            }
            if (key === 'saveerror' && lastError) {
                text += ' (' + lastError + ')';
            }
            stateEl.textContent = text;
            stateEl.className = 'mylkpd-savestate small mylkpd-state-' + (key || 'none');
        }

        // ------------------------------------------------ Equations.

        function renderTex(el, tex) {
            if (katex) {
                try {
                    katex.render(tex, el, {throwOnError: false, trust: false, strict: 'ignore'});
                    return;
                } catch (err) {
                    // Fall through to plain text.
                }
            }
            el.textContent = tex;
        }

        function mathChip(tex) {
            var chip = document.createElement('span');
            chip.className = 'mylkpd-math';
            chip.contentEditable = 'false';
            chip.setAttribute('data-tex', tex);
            renderTex(chip, tex);
            return chip;
        }

        /**
         * Paragraph HTML as stored: equation chips become plain \(TeX\) text, which HTMLPurifier keeps.
         *
         * @param {HTMLElement} p
         * @return {String}
         */
        function serializeBlock(p) {
            var clone = p.cloneNode(true);
            Array.prototype.forEach.call(clone.querySelectorAll('.mylkpd-math'), function(c) {
                c.parentNode.replaceChild(document.createTextNode('\\(' + c.getAttribute('data-tex') + '\\)'), c);
            });
            return clone.innerHTML;
        }

        /**
         * Turns \(TeX\) text inside a paragraph into rendered equation chips; makes links open in a new tab.
         *
         * @param {HTMLElement} p
         */
        function hydrateBlock(p) {
            var walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT, null);
            var nodes = [];
            while (walker.nextNode()) {
                if (walker.currentNode.nodeValue.indexOf('\\(') >= 0) {
                    nodes.push(walker.currentNode);
                }
            }
            nodes.forEach(function(node) {
                var text = node.nodeValue;
                var re = /\\\((.+?)\\\)/g;
                var frag = document.createDocumentFragment();
                var last = 0;
                var m;
                while ((m = re.exec(text)) !== null) {
                    frag.appendChild(document.createTextNode(text.slice(last, m.index)));
                    frag.appendChild(mathChip(m[1]));
                    last = re.lastIndex;
                }
                if (last > 0) {
                    frag.appendChild(document.createTextNode(text.slice(last)));
                    node.parentNode.replaceChild(frag, node);
                }
            });
            Array.prototype.forEach.call(p.querySelectorAll('a[href]'), function(a) {
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
            });
        }

        // ------------------------------------------------ Saving and syncing.

        function scheduleSave(delay) {
            if (readonly) {
                return;
            }
            clearTimeout(saveTimer);
            saveTimer = setTimeout(flush, delay === undefined ? 700 : delay);
        }

        function changed() {
            scheduleSave();
        }

        function collectOps() {
            var ops = [];
            var seen = {};
            items.forEach(function(it) {
                seen[it.id] = true;
                var c = canon(it);
                if (shadowItems[it.id] !== c) {
                    ops.push({op: 'put', kind: 'item', id: it.id, data: strip(it)});
                    shadowItems[it.id] = c;
                }
            });
            Object.keys(shadowItems).forEach(function(id) {
                if (!seen[id]) {
                    ops.push({op: 'del', kind: 'item', id: id});
                    delete shadowItems[id];
                }
            });
            Object.keys(touched).forEach(function(id) {
                var el = blockEls[id];
                var html = el ? serializeBlock(el) : null;
                if (el && html !== shadowBlocks[id]) {
                    ops.push({op: 'put', kind: 'block', id: id, html: html});
                    shadowBlocks[id] = html;
                }
                delete touched[id];
            });
            // Older unsent operations first; a later operation on the same thing replaces an earlier one.
            var all = outbox.concat(ops);
            var map = {};
            var order = [];
            all.forEach(function(o) {
                var k = o.kind + ':' + o.id;
                if (!(k in map)) {
                    order.push(k);
                }
                map[k] = o;
            });
            outbox = [];
            return order.map(function(k) {
                return map[k];
            });
        }

        function hasPending() {
            if (outbox.length || Object.keys(touched).length) {
                return true;
            }
            var seen = {};
            var dirty = items.some(function(it) {
                seen[it.id] = true;
                return shadowItems[it.id] !== canon(it);
            });
            return dirty || Object.keys(shadowItems).some(function(id) {
                return !seen[id];
            });
        }

        function inOutbox(kind, id) {
            return outbox.some(function(o) {
                return o.kind === kind && o.id === id;
            });
        }

        function requestBody(ops) {
            var body = new URLSearchParams();
            body.append('sesskey', cfg.sesskey);
            body.append('cmid', cfg.cmid);
            body.append('rev', rev);
            body.append('ops', JSON.stringify(ops));
            body.append('block', currentBlock);
            return body;
        }

        function flush() {
            if (readonly || !cfg.syncUrl) {
                return Promise.resolve();
            }
            clearTimeout(saveTimer);
            if (inflight) {
                again = true;
                return inflight;
            }
            var ops = collectOps();
            if (ops.length) {
                setState('saving');
            }
            inflight = fetch(cfg.syncUrl, {
                method: 'POST',
                credentials: 'same-origin',
                headers: {'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'},
                body: requestBody(ops)
            }).then(function(r) {
                return r.json();
            }).then(function(res) {
                if (!res || typeof res.rev !== 'number') {
                    throw new Error((res && (res.error || res.message)) || 'Sync failed');
                }
                failed = false;
                lastError = '';
                applyRemote(res);
                if (ops.length || (stateEl && stateEl.classList.contains('mylkpd-state-saveerror'))) {
                    setState('saved');
                }
                if (res.status === 1) {
                    // Someone (a group mate) submitted: reload to show the locked worksheet.
                    window.removeEventListener('beforeunload', warnUnsaved);
                    window.location.reload();
                }
            }).catch(function(err) {
                outbox = ops.concat(outbox);
                failed = true;
                lastError = (err && err.message) ? String(err.message).slice(0, 120) : '';
                setState('saveerror');
                window.console.error('MyLKPD sync:', err);
            }).then(function() {
                inflight = null;
                if (again || failed) {
                    again = false;
                    scheduleSave(failed ? 5000 : 200);
                }
            });
            return inflight;
        }

        function applyRemote(res) {
            rev = Math.max(rev, res.rev);
            var touchedPages = false;
            Object.keys(res.items || {}).forEach(function(id) {
                var r = res.items[id];
                var idx = indexOfId(id);
                var local = idx >= 0 ? items[idx] : null;
                if ((local && canon(local) !== shadowItems[id]) || inOutbox('item', id)) {
                    return; // We have a newer unsent change; ours will win when it is sent.
                }
                if (r.deleted) {
                    if (local) {
                        removeItem(local, true);
                    }
                    delete shadowItems[id];
                    return;
                }
                var item = copy(r);
                item.id = id;
                shadowItems[id] = canon(item);
                if (local && canon(local) === shadowItems[id]) {
                    local.by = item.by;
                    updateLabel(local);
                    return;
                }
                if (local) {
                    removeItem(local, true);
                    items.splice(idx, 0, item);
                } else {
                    items.push(item);
                }
                createEl(item);
                touchedPages = true;
            });
            Object.keys(res.blocks || {}).forEach(function(id) {
                var b = res.blocks[id];
                var el = blockEls[id];
                if (!el || el === document.activeElement || touched[id] || inOutbox('block', id) ||
                        serializeBlock(el) !== shadowBlocks[id]) {
                    return;
                }
                if (b.html !== undefined && b.html !== serializeBlock(el)) {
                    el.innerHTML = b.html;
                    hydrateBlock(el);
                }
                shadowBlocks[id] = serializeBlock(el);
                markEdited(el, b.by);
            });
            if (res.presence) {
                applyPresence(res.presence);
            }
            return touchedPages;
        }

        function applyPresence(list) {
            var locks = {};
            var online = [];
            list.forEach(function(p) {
                if (p.ago < 40) {
                    online.push(p.userid);
                }
                if (p.userid !== cfg.userid && p.block !== '' && p.ago < 25) {
                    locks[p.block] = p.userid;
                }
            });
            Object.keys(blockEls).forEach(function(id) {
                var el = blockEls[id];
                var uid = locks[id];
                if (uid && el !== document.activeElement) {
                    el.contentEditable = 'false';
                    el.classList.add('mylkpd-locked');
                    el.setAttribute('data-mylkpd-editor', cfg.strings.editing.replace('{name}', memberName(uid)));
                    el.style.setProperty('--mylkpd-peer', members[uid] ? members[uid].color : '#666');
                } else if (el.classList.contains('mylkpd-locked')) {
                    el.classList.remove('mylkpd-locked');
                    el.removeAttribute('data-mylkpd-editor');
                    el.contentEditable = readonly ? 'false' : 'true';
                }
            });
            if (presenceEl) {
                presenceEl.textContent = '';
                var label = document.createElement('span');
                label.className = 'mylkpd-presence-label';
                label.textContent = cfg.strings.online + ':';
                presenceEl.appendChild(label);
                Object.keys(members).forEach(function(uidKey) {
                    var uid = parseInt(uidKey, 10);
                    var chip = document.createElement('span');
                    chip.className = 'mylkpd-chip' + (online.indexOf(uid) >= 0 ? ' mylkpd-online' : '');
                    var dot = document.createElement('span');
                    dot.className = 'mylkpd-dot';
                    dot.style.background = members[uidKey].color;
                    chip.appendChild(dot);
                    chip.appendChild(document.createTextNode(members[uidKey].name +
                        (uid === cfg.userid ? ' (' + cfg.strings.you + ')' : '')));
                    presenceEl.appendChild(chip);
                });
            }
        }

        // ------------------------------------------------ Undo (per change, so it never undoes a group mate).

        function updateUndo() {
            var b = document.querySelector('[data-mylkpd-action="undo"]');
            if (b) {
                b.disabled = tool !== 'type' && undoStack.length === 0;
            }
            var r = document.querySelector('[data-mylkpd-action="redo"]');
            if (r) {
                r.disabled = tool !== 'type';
            }
        }

        function recordUndo(group) {
            undoStack.push(group);
            if (undoStack.length > MAX_UNDO) {
                undoStack.shift();
            }
            updateUndo();
        }

        function indexOfId(id) {
            for (var i = 0; i < items.length; i++) {
                if (items[i].id === id) {
                    return i;
                }
            }
            return -1;
        }

        function undo() {
            var group = undoStack.pop();
            if (!group) {
                return;
            }
            for (var i = group.length - 1; i >= 0; i--) {
                var e = group[i];
                var idx = indexOfId(e.id);
                if (e.before === null) {
                    if (idx >= 0) {
                        items.splice(idx, 1);
                    }
                } else if (idx >= 0) {
                    items[idx] = copy(e.before);
                } else {
                    items.push(copy(e.before));
                }
            }
            rebuild();
            changed();
            updateUndo();
        }

        // ------------------------------------------------ Author name labels (group work).

        function authorName(uid) {
            return members[uid] ? members[uid].name : '';
        }

        function labelAnchor(item) {
            if (item.type === 'line') {
                return {x: Math.min(item.x1, item.x2), y: Math.min(item.y1, item.y2)};
            }
            if (item.type === 'pen') {
                var minx = 100;
                var miny = 100;
                item.points.forEach(function(q) {
                    minx = Math.min(minx, q[0]);
                    miny = Math.min(miny, q[1]);
                });
                return {x: minx, y: miny};
            }
            return {x: item.x, y: item.y};
        }

        function updateLabel(item) {
            var label = labels.get(item);
            var name = showNames ? authorName(item.by) : '';
            if (!name) {
                if (label && label.parentNode) {
                    label.parentNode.removeChild(label);
                }
                labels.delete(item);
                return;
            }
            var page = pages[item.page];
            if (!page) {
                return;
            }
            if (!label) {
                label = document.createElement('div');
                label.setAttribute('aria-hidden', 'true');
                labels.set(item, label);
            }
            label.className = 'mylkpd-namelabel mylkpd-namelabel-' + item.type;
            label.textContent = name;
            label.style.background = members[item.by].color;
            var a = labelAnchor(item);
            label.style.left = a.x + '%';
            label.style.top = a.y + '%';
            if (label.parentNode !== page.html) {
                page.html.appendChild(label);
            }
        }

        function removeLabel(item) {
            var label = labels.get(item);
            if (label && label.parentNode) {
                label.parentNode.removeChild(label);
            }
            labels.delete(item);
        }

        function claim(item) {
            // The current user is now the last one who changed this item.
            if (item.by !== cfg.userid) {
                item.by = cfg.userid;
                updateLabel(item);
            }
        }

        // ------------------------------------------------ Drawing items.

        function strokeStyle(w) {
            return 'stroke-width: calc(var(--mylkpd-k, 1) * ' + (w || 4) + 'px)';
        }

        function makeShape(item) {
            var s;
            if (item.type === 'ellipse') {
                s = svgEl('ellipse', {cx: item.x + item.w / 2, cy: item.y + item.h / 2,
                    rx: item.w / 2, ry: item.h / 2, fill: 'none'});
            } else if (item.type === 'highlight') {
                return svgEl('rect', {x: item.x, y: item.y, width: item.w, height: item.h,
                    fill: item.color, 'fill-opacity': '0.35', stroke: 'none'});
            } else if (item.type === 'line') {
                s = svgEl('line', {x1: item.x1, y1: item.y1, x2: item.x2, y2: item.y2, 'stroke-linecap': 'round'});
            } else {
                s = svgEl('polyline', {points: item.points.map(function(p) {
                    return p[0] + ',' + p[1];
                }).join(' '), fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round'});
            }
            s.setAttribute('stroke', item.color);
            s.setAttribute('vector-effect', 'non-scaling-stroke');
            s.setAttribute('style', strokeStyle(item.width));
            return s;
        }

        function draw(item) {
            var el = elems.get(item);
            if (!el) {
                return;
            }
            if (labels.has(item)) {
                updateLabel(item);
            }
            if (item.type === 'text' || item.type === 'check' || item.type === 'cross' ||
                    item.type === 'math' || item.type === 'link') {
                el.style.left = item.x + '%';
                el.style.top = item.y + '%';
                return;
            }
            while (el.firstChild) {
                el.removeChild(el.firstChild);
            }
            var hit = makeShape(item);
            hit.setAttribute('class', 'mylkpd-hit ' + (item.type === 'highlight' ? 'mylkpd-hit-fill' : 'mylkpd-hit-stroke'));
            el.appendChild(hit);
            el.appendChild(makeShape(item));
        }

        function createText(item) {
            var el = document.createElement('div');
            el.className = 'mylkpd-item mylkpd-text';
            var ta = document.createElement('textarea');
            ta.rows = 1;
            ta.value = item.text || '';
            ta.readOnly = readonly;
            ta.spellcheck = false;
            ta.style.color = item.color;
            ta.style.borderColor = item.color;
            ta.setAttribute('aria-label', cfg.strings.answer);
            ta.dir = 'auto'; // Arabic answers are written right to left.
            if (item.by && memberName(item.by)) {
                el.title = cfg.strings.editedby.replace('{name}', memberName(item.by));
            }
            if (!readonly) {
                var before = null;
                ta.addEventListener('focus', function() {
                    // New boxes are already covered by the undo entry made when they were created.
                    before = item.text ? copy(item) : null;
                });
                ta.addEventListener('input', function() {
                    if (before) {
                        recordUndo([{id: item.id, before: before}]);
                        before = null;
                    }
                    item.text = ta.value;
                    grow(ta);
                    claim(item);
                    changed();
                });
                ta.addEventListener('blur', function() {
                    if (ta.value.trim() === '' && items.indexOf(item) >= 0) {
                        // An empty box was never really an answer: drop it and its undo entry.
                        var top = undoStack[undoStack.length - 1];
                        if (top && top.length === 1 && top[0].id === item.id && top[0].before === null) {
                            undoStack.pop();
                            updateUndo();
                        }
                        removeItem(item);
                    }
                });
            }
            el.appendChild(ta);
            return el;
        }

        function createEl(item) {
            var page = pages[item.page];
            if (!page) {
                return null;
            }
            var el;
            if (item.type === 'text') {
                el = createText(item);
            } else if (item.type === 'math') {
                el = document.createElement('div');
                el.className = 'mylkpd-item mylkpd-mathitem';
                el.style.color = item.color;
                renderTex(el, item.tex);
                if (!readonly) {
                    el.addEventListener('dblclick', function() {
                        editMathItem(item);
                    });
                }
            } else if (item.type === 'link') {
                el = document.createElement('a');
                el.className = 'mylkpd-item mylkpd-linkitem';
                el.href = item.url;
                el.target = '_blank';
                el.rel = 'noopener noreferrer';
                el.textContent = item.text || item.url;
                el.title = item.url;
                el.style.color = item.color;
                el.addEventListener('click', function(e) {
                    if (tool === 'move' || tool === 'erase') {
                        e.preventDefault();
                    }
                });
            } else if (item.type === 'check' || item.type === 'cross') {
                el = document.createElement('div');
                el.className = 'mylkpd-item mylkpd-mark';
                el.textContent = item.type === 'check' ? '\u2713' : '\u2717';
                el.style.color = item.color;
                el.setAttribute('role', 'img');
                el.setAttribute('aria-label', cfg.strings[item.type]);
            } else {
                el = svgEl('g', {'class': 'mylkpd-item'});
            }
            (el.namespaceURI === SVGNS ? page.svg : page.html).appendChild(el);
            elems.set(item, el);
            owners.set(el, item);
            draw(item);
            updateLabel(item);
            if (item.type === 'text') {
                grow(el.firstChild);
            }
            return el;
        }

        function removeItem(item, silent) {
            var i = items.indexOf(item);
            if (i >= 0) {
                items.splice(i, 1);
            }
            var el = elems.get(item);
            elems.delete(item);
            if (el && el.parentNode) {
                el.parentNode.removeChild(el);
            }
            removeLabel(item);
            if (!silent) {
                changed();
            }
        }

        function rebuild() {
            var old = elems;
            elems = new Map();
            old.forEach(function(el) {
                if (el.parentNode) {
                    el.parentNode.removeChild(el);
                }
            });
            labels.forEach(function(label) {
                if (label.parentNode) {
                    label.parentNode.removeChild(label);
                }
            });
            labels = new Map();
            items.forEach(createEl);
        }

        // ------------------------------------------------ Pointer input (annotate mode).

        function pointFrom(layer, e) {
            var r = layer.getBoundingClientRect();
            return {x: clamp((e.clientX - r.left) / r.width * 100), y: clamp((e.clientY - r.top) / r.height * 100)};
        }

        function itemAt(e) {
            var target = closestItem(document.elementFromPoint(e.clientX, e.clientY));
            return target ? owners.get(target) : null;
        }

        function eraseAt(e, state) {
            var item = itemAt(e);
            if (!item || items.indexOf(item) < 0) {
                return;
            }
            if (!state.group) {
                state.group = [];
                recordUndo(state.group);
            }
            state.group.push({id: item.id, before: copy(item)});
            removeItem(item);
        }

        function moveItem(state, p) {
            var o = state.orig;
            var it = state.item;
            var dx = p.x - state.start.x;
            var dy = p.y - state.start.y;
            if (o.type === 'line') {
                it.x1 = clamp(o.x1 + dx);
                it.y1 = clamp(o.y1 + dy);
                it.x2 = clamp(o.x2 + dx);
                it.y2 = clamp(o.y2 + dy);
            } else if (o.type === 'pen') {
                it.points = o.points.map(function(q) {
                    return [clamp(q[0] + dx), clamp(q[1] + dy)];
                });
            } else {
                it.x = clamp(o.x + dx);
                it.y = clamp(o.y + dy);
            }
        }

        function bindPointer(num, layer) {
            var state = null;

            layer.addEventListener('pointerdown', function(e) {
                if (e.button !== 0) {
                    return;
                }
                var p = pointFrom(layer, e);
                var targetEl = closestItem(e.target);
                var targetItem = targetEl ? owners.get(targetEl) : null;

                if (tool === 'math' || tool === 'link') {
                    e.preventDefault();
                    placeItem(tool, num, p);
                    return;
                }
                if (tool === 'text' || tool === 'check' || tool === 'cross') {
                    if (targetEl) {
                        return; // Let the student click into an existing box.
                    }
                    e.preventDefault();
                    var it = {id: newId(), page: num, type: tool, x: p.x, y: p.y, color: color, by: cfg.userid};
                    if (tool === 'text') {
                        it.text = '';
                    }
                    recordUndo([{id: it.id, before: null}]);
                    items.push(it);
                    var el = createEl(it);
                    changed();
                    if (tool === 'text' && el) {
                        el.firstChild.focus();
                    }
                    return;
                }

                e.preventDefault();
                if (document.activeElement && document.activeElement.blur) {
                    document.activeElement.blur();
                }
                if (tool === 'erase') {
                    state = {mode: 'erase', group: null};
                    layer.setPointerCapture(e.pointerId);
                    eraseAt(e, state);
                    return;
                }
                if (tool === 'move') {
                    if (!targetItem) {
                        return;
                    }
                    state = {mode: 'move', item: targetItem, start: p, orig: copy(targetItem)};
                    layer.setPointerCapture(e.pointerId);
                    return;
                }

                var shape;
                if (tool === 'circle' || tool === 'highlight') {
                    shape = {page: num, type: tool === 'circle' ? 'ellipse' : 'highlight',
                        x: p.x, y: p.y, w: 0, h: 0, color: color};
                } else if (tool === 'line') {
                    shape = {page: num, type: 'line', x1: p.x, y1: p.y, x2: p.x, y2: p.y, color: color};
                } else {
                    shape = {page: num, type: 'pen', points: [[p.x, p.y]], color: color};
                }
                shape.id = newId();
                shape.by = cfg.userid;
                if (shape.type !== 'highlight') {
                    shape.width = width;
                }
                state = {mode: 'draw', item: shape, start: p};
                items.push(shape);
                createEl(shape);
                layer.setPointerCapture(e.pointerId);
            });

            layer.addEventListener('pointermove', function(e) {
                if (!state) {
                    return;
                }
                if (state.mode === 'erase') {
                    eraseAt(e, state);
                    return;
                }
                var p = pointFrom(layer, e);
                if (state.mode === 'move') {
                    moveItem(state, p);
                    draw(state.item);
                    return;
                }
                var it = state.item;
                var s = state.start;
                if (it.type === 'ellipse' || it.type === 'highlight') {
                    it.x = Math.min(s.x, p.x);
                    it.y = Math.min(s.y, p.y);
                    it.w = clamp(Math.abs(p.x - s.x));
                    it.h = clamp(Math.abs(p.y - s.y));
                } else if (it.type === 'line') {
                    it.x2 = p.x;
                    it.y2 = p.y;
                } else {
                    var last = it.points[it.points.length - 1];
                    if (Math.abs(last[0] - p.x) + Math.abs(last[1] - p.y) > 0.2 && it.points.length < 3000) {
                        it.points.push([p.x, p.y]);
                    }
                }
                draw(it);
            });

            function finish(e) {
                if (!state) {
                    return;
                }
                var st = state;
                state = null;
                try {
                    layer.releasePointerCapture(e.pointerId);
                } catch (err) {
                    // Capture may already be gone.
                }
                if (st.mode === 'draw') {
                    var it = st.item;
                    var tiny = false;
                    if (it.type === 'ellipse' || it.type === 'highlight') {
                        tiny = it.w < 0.5 && it.h < 0.5;
                        if (!tiny && it.type === 'highlight' && it.h < 1.5) {
                            // A quick horizontal swipe makes a marker stripe.
                            it.y = clamp(it.y - (1.5 - it.h) / 2);
                            it.h = 1.5;
                        }
                    } else if (it.type === 'line') {
                        tiny = Math.abs(it.x2 - it.x1) + Math.abs(it.y2 - it.y1) < 0.5;
                    } else if (it.points.length < 2) {
                        it.points.push(it.points[0].slice()); // A single tap leaves a dot.
                    }
                    if (tiny) {
                        removeItem(it, true);
                        return;
                    }
                    draw(it);
                    recordUndo([{id: it.id, before: null}]);
                    changed();
                } else if (st.mode === 'move' && canon(st.item) !== canon(st.orig)) {
                    claim(st.item);
                    recordUndo([{id: st.item.id, before: st.orig}]);
                    changed();
                }
            }
            layer.addEventListener('pointerup', finish);
            layer.addEventListener('pointercancel', finish);
        }

        // ------------------------------------------------ Pages.

        function setupPage(num, host) {
            host.classList.add('mylkpd-host');
            var layer = document.createElement('div');
            layer.className = 'mylkpd-layer';
            var svg = svgEl('svg', {viewBox: '0 0 100 100', preserveAspectRatio: 'none', 'class': 'mylkpd-svg'});
            var html = document.createElement('div');
            html.className = 'mylkpd-html';
            layer.appendChild(svg);
            layer.appendChild(html);
            host.appendChild(layer);
            pages[num] = {layer: layer, svg: svg, html: html};

            var setScale = function() {
                layer.style.setProperty('--mylkpd-k', Math.max(0.4, layer.clientWidth / 800).toFixed(3));
            };
            setScale();
            if (window.ResizeObserver) {
                new ResizeObserver(setScale).observe(layer);
            }
            if (!readonly) {
                bindPointer(num, layer);
            }
        }

        // ------------------------------------------------ Edit mode: paragraphs of the .docx.

        function markEdited(el, by) {
            el.classList.add('mylkpd-edited');
            if (by && members[by]) {
                el.style.setProperty('--mylkpd-peer', members[by].color);
                el.title = cfg.strings.editedby.replace('{name}', authorName(by));
                if (showNames) {
                    el.setAttribute('data-mylkpd-by', authorName(by));
                }
            }
        }

        function makeEditable(p, id) {
            p.contentEditable = 'true';
            p.spellcheck = false;
            p.addEventListener('input', function() {
                touched[id] = true;
                markEdited(p, cfg.userid);
                scheduleSave();
            });
            p.addEventListener('focus', function() {
                currentBlock = id;
                if (cfg.collab) {
                    scheduleSave(150); // Tell group mates right away that this paragraph is taken.
                }
            });
            p.addEventListener('blur', function() {
                if (currentBlock === id) {
                    currentBlock = '';
                }
                if (cfg.collab || touched[id]) {
                    scheduleSave(150);
                }
            });
            p.addEventListener('keydown', function(e) {
                if (e.key === 'Enter') {
                    // Keep one paragraph per block so every member's paragraphs line up.
                    e.preventDefault();
                    document.execCommand('insertLineBreak');
                }
            });
            p.addEventListener('paste', function(e) {
                e.preventDefault();
                var text = (e.clipboardData || window.clipboardData).getData('text');
                document.execCommand('insertText', false, text);
            });
            p.addEventListener('drop', function(e) {
                e.preventDefault();
            });
            p.addEventListener('click', function(e) {
                var chip = e.target.closest ? e.target.closest('.mylkpd-math') : null;
                if (chip && tool === 'type') {
                    editMathChip(chip, id);
                    return;
                }
                var a = e.target.closest ? e.target.closest('a[href]') : null;
                if (a && (e.ctrlKey || e.metaKey)) {
                    window.open(a.href, '_blank', 'noopener');
                }
            });
        }

        function setupBlocks(holder) {
            var saved = cfg.blocks || {};
            var ps = holder.querySelectorAll('section.docx > article p');
            Array.prototype.forEach.call(ps, function(p, i) {
                var id = String(i);
                blockEls[id] = p;
                p.setAttribute('data-mylkpd-block', id);
                p.classList.add('mylkpd-block');
                if (saved[id] && typeof saved[id].html === 'string') {
                    p.innerHTML = saved[id].html;
                    markEdited(p, saved[id].by);
                }
                hydrateBlock(p);
                shadowBlocks[id] = serializeBlock(p);
                if (!readonly) {
                    makeEditable(p, id);
                }
            });
        }

        // ------------------------------------------------ Rendering the document.

        function renderPdf(width) {
            return loadPdfjs(cfg.pdfjsBase).then(function(pdfjsLib) {
                pdfjsLib.GlobalWorkerOptions.workerSrc = cfg.workerUrl;
                return pdfjsLib.getDocument(cfg.docUrl).promise;
            }).then(function(pdf) {
                var chain = Promise.resolve();
                var renderPage = function(num) {
                    return pdf.getPage(num).then(function(page) {
                        var base = page.getViewport({scale: 1});
                        var ratio = window.devicePixelRatio || 1;
                        var vp = page.getViewport({scale: (width / base.width) * ratio});
                        var wrap = document.createElement('div');
                        wrap.className = 'mylkpd-page';
                        wrap.style.aspectRatio = base.width + ' / ' + base.height;
                        var canvas = document.createElement('canvas');
                        canvas.width = Math.floor(vp.width);
                        canvas.height = Math.floor(vp.height);
                        wrap.appendChild(canvas);
                        container.appendChild(wrap);
                        setupPage(num, wrap);
                        return page.render({canvasContext: canvas.getContext('2d'), viewport: vp}).promise;
                    });
                };
                for (var n = 1; n <= pdf.numPages; n++) {
                    chain = chain.then(renderPage.bind(null, n));
                }
                return chain;
            });
        }

        function renderDocx() {
            var holder = document.createElement('div');
            holder.className = 'mylkpd-docx';
            container.appendChild(holder);
            var fit = function() {
                holder.style.zoom = '';
                var wrapper = holder.firstElementChild;
                var needed = wrapper ? wrapper.scrollWidth : 0;
                var avail = container.clientWidth;
                if (needed > avail && avail > 0) {
                    holder.style.zoom = (avail / needed).toFixed(3);
                }
            };
            return loadDocx(cfg.docxBase).then(function(docx) {
                return fetch(cfg.docUrl, {credentials: 'same-origin'}).then(function(r) {
                    if (!r.ok) {
                        throw new Error('HTTP ' + r.status);
                    }
                    return r.blob();
                }).then(function(blob) {
                    return docx.renderAsync(blob, holder, null, {
                        inWrapper: true,
                        breakPages: true,
                        ignoreLastRenderedPageBreak: false,
                        renderHeaders: true,
                        renderFooters: true,
                        useBase64URL: true,
                        experimental: false
                    });
                });
            }).then(function() {
                if (canType) {
                    setupBlocks(holder);
                }
                Array.prototype.forEach.call(holder.querySelectorAll('section.docx'), function(section, i) {
                    setupPage(i + 1, section);
                });
                fit();
                window.addEventListener('resize', fit);
            });
        }

        // ------------------------------------------------ Insert tools (equation, symbol, Arabic, link).

        var MATH_TEMPLATES = [
            ['\\frac{a}{b}', '\\frac{|}{}'], ['x^{n}', '^{|}'], ['x_{n}', '_{|}'], ['\\sqrt{x}', '\\sqrt{|}'],
            ['\\sqrt[n]{x}', '\\sqrt[|]{}'], ['\\left(x\\right)', '\\left( | \\right)'], ['\\sum_{i=1}^{n}', '\\sum_{i=1}^{n} |'],
            ['\\int_{a}^{b}', '\\int_{|}^{} '], ['\\lim_{x\\to a}', '\\lim_{x \\to |} '], ['\\vec{v}', '\\vec{|}'],
            ['\\overline{AB}', '\\overline{|}'], ['\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}', '\\begin{pmatrix}|&\\\\&\\end{pmatrix}'],
            ['\\pm', '\\pm '], ['\\times', '\\times '], ['\\div', '\\div '], ['\\cdot', '\\cdot '], ['\\le', '\\le '],
            ['\\ge', '\\ge '], ['\\ne', '\\ne '], ['\\approx', '\\approx '], ['\\infty', '\\infty '], ['\\pi', '\\pi '],
            ['\\alpha', '\\alpha '], ['\\beta', '\\beta '], ['\\theta', '\\theta '], ['\\Delta', '\\Delta '],
            ['x^{\\circ}', '^{\\circ}|'], ['\\rightarrow', '\\rightarrow '], ['\\angle', '\\angle '], ['\\perp', '\\perp ']
        ];
        var SYMBOLS = ('± × ÷ = ≠ ≈ ≤ ≥ < > √ ∛ ∞ π ° ∠ ⊥ ∥ △ ∑ ∫ Δ α β γ θ λ μ σ ω Ω ² ³ ¹ ½ ¼ ¾ ' +
            '→ ← ↑ ↓ ↔ ⇒ ⇔ ∈ ∉ ⊂ ∪ ∩ ∅ ∴ ∵ • … — « » € © ‰ ℃').split(' ');
        var ARABIC_ROWS = [
            'ض ص ث ق ف غ ع ه خ ح ج د',
            'ش س ي ب ل ا ت ن م ك ط',
            'ئ ء ؤ ر لا ى ة و ز ظ ذ',
            'آ أ إ ـ \u064E \u0650 \u064F \u0652 \u0651 \u064B \u064D \u064C \u0670',
            '٠ ١ ٢ ٣ ٤ ٥ ٦ ٧ ٨ ٩ ، ؛ ؟'
        ];

        function flashHint(text) {
            if (!hintEl) {
                return;
            }
            hintEl.textContent = text;
            hintEl.classList.add('text-danger');
            setTimeout(function() {
                hintEl.classList.remove('text-danger');
                hintEl.textContent = (tool === 'math' || tool === 'link') ? cfg.strings.clicktoplace : hintText;
            }, 3500);
        }

        function isTarget(el) {
            return el && document.body.contains(el) && !el.readOnly &&
                (el.tagName === 'TEXTAREA' || (el.classList.contains('mylkpd-block') && el.isContentEditable));
        }

        // Remember where the student was typing, so toolbar buttons and dialogs can insert there.
        container.addEventListener('focusin', function(e) {
            if (isTarget(e.target)) {
                lastTarget = e.target;
            }
        });
        document.addEventListener('selectionchange', function() {
            var sel = window.getSelection();
            if (sel.rangeCount && lastTarget && lastTarget.tagName !== 'TEXTAREA' &&
                    lastTarget.contains(sel.getRangeAt(0).startContainer)) {
                savedRange = sel.getRangeAt(0).cloneRange();
            }
        });

        /**
         * Puts the cursor back where the student was typing.
         *
         * @param {Boolean} paragraphsOnly
         * @return {Boolean} whether there is a place to type
         */
        function focusTarget(paragraphsOnly) {
            if (!isTarget(lastTarget) || (paragraphsOnly && lastTarget.tagName === 'TEXTAREA')) {
                return false;
            }
            if (document.activeElement !== lastTarget) {
                lastTarget.focus();
            }
            if (lastTarget.tagName !== 'TEXTAREA' && savedRange && lastTarget.contains(savedRange.startContainer)) {
                var sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(savedRange);
            }
            return true;
        }

        function insertText(text) {
            if (!focusTarget(false)) {
                flashHint(cfg.strings.needfocus);
                return;
            }
            if (lastTarget.tagName === 'TEXTAREA') {
                lastTarget.setRangeText(text, lastTarget.selectionStart, lastTarget.selectionEnd, 'end');
                lastTarget.dispatchEvent(new Event('input', {bubbles: true}));
            } else {
                document.execCommand('insertText', false, text);
            }
        }

        function deleteBack() {
            if (!focusTarget(false)) {
                return;
            }
            if (lastTarget.tagName === 'TEXTAREA') {
                var start = lastTarget.selectionStart;
                var end = lastTarget.selectionEnd;
                if (start === end && start > 0) {
                    // Remove one code point (Arabic letters and marks are single code units).
                    start -= 1;
                }
                lastTarget.setRangeText('', start, end, 'end');
                lastTarget.dispatchEvent(new Event('input', {bubbles: true}));
            } else {
                document.execCommand('delete');
            }
        }

        function insertNode(node) {
            if (!focusTarget(true)) {
                flashHint(cfg.strings.needfocus);
                return false;
            }
            var sel = window.getSelection();
            var range = sel.getRangeAt(0);
            range.deleteContents();
            range.insertNode(node);
            range.setStartAfter(node);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
            lastTarget.dispatchEvent(new Event('input', {bubbles: true}));
            return true;
        }

        function keepFocus(el) {
            el.addEventListener('mousedown', function(e) {
                if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
                    e.preventDefault();
                }
            });
        }

        // ---- Modal dialog.

        function dialog(title, build) {
            return new Promise(function(resolve) {
                var back = document.createElement('div');
                back.className = 'mylkpd-modal-back';
                var box = document.createElement('div');
                box.className = 'mylkpd-modal';
                box.setAttribute('role', 'dialog');
                box.setAttribute('aria-modal', 'true');
                box.setAttribute('aria-label', title);
                var h = document.createElement('h3');
                h.textContent = title;
                box.appendChild(h);
                var body = document.createElement('div');
                box.appendChild(body);
                var actions = document.createElement('div');
                actions.className = 'mylkpd-modal-actions';
                var cancel = document.createElement('button');
                cancel.type = 'button';
                cancel.className = 'btn btn-secondary';
                cancel.textContent = cfg.strings.cancel;
                var ok = document.createElement('button');
                ok.type = 'button';
                ok.className = 'btn btn-primary';
                ok.textContent = cfg.strings.insert;
                actions.appendChild(cancel);
                actions.appendChild(ok);
                box.appendChild(actions);
                back.appendChild(box);
                document.body.appendChild(back);
                var getValue = build(body, function() {
                    ok.click();
                });
                var done = function(value) {
                    document.removeEventListener('keydown', onKey, true);
                    back.parentNode.removeChild(back);
                    resolve(value);
                };
                var onKey = function(e) {
                    if (e.key === 'Escape') {
                        e.preventDefault();
                        done(null);
                    }
                };
                document.addEventListener('keydown', onKey, true);
                cancel.addEventListener('click', function() {
                    done(null);
                });
                back.addEventListener('mousedown', function(e) {
                    if (e.target === back) {
                        done(null);
                    }
                });
                ok.addEventListener('click', function() {
                    var v = getValue();
                    if (v !== false) {
                        done(v);
                    }
                });
                var first = body.querySelector('textarea, input');
                if (first) {
                    first.focus();
                }
            });
        }

        function mathDialog(initial) {
            return dialog(cfg.strings.mathtitle, function(body, submit) {
                var palette = document.createElement('div');
                palette.className = 'mylkpd-math-palette';
                var input = document.createElement('textarea');
                input.className = 'form-control mylkpd-math-input';
                input.rows = 2;
                input.spellcheck = false;
                input.dir = 'ltr';
                input.value = initial || '';
                input.setAttribute('aria-label', 'LaTeX');
                var preview = document.createElement('div');
                preview.className = 'mylkpd-math-preview';
                preview.setAttribute('aria-label', cfg.strings.mathpreview);
                var hint = document.createElement('div');
                hint.className = 'small text-muted';
                hint.textContent = cfg.strings.mathhint;
                var update = function() {
                    if (input.value.trim()) {
                        renderTex(preview, input.value);
                    } else {
                        preview.textContent = '';
                    }
                };
                MATH_TEMPLATES.forEach(function(t) {
                    var b = document.createElement('button');
                    b.type = 'button';
                    b.className = 'btn btn-light btn-sm';
                    b.title = t[0];
                    renderTex(b, t[0]);
                    b.addEventListener('click', function() {
                        var start = input.selectionStart;
                        var parts = t[1].split('|');
                        input.setRangeText(parts.join(''), start, input.selectionEnd, 'end');
                        var caret = start + parts[0].length;
                        input.focus();
                        input.setSelectionRange(caret, caret);
                        update();
                    });
                    palette.appendChild(b);
                });
                input.addEventListener('input', update);
                input.addEventListener('keydown', function(e) {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        submit();
                    }
                });
                body.appendChild(palette);
                body.appendChild(input);
                body.appendChild(hint);
                body.appendChild(preview);
                update();
                return function() {
                    var tex = input.value.trim();
                    return tex ? tex.slice(0, 1000) : false;
                };
            });
        }

        function linkDialog(initialText) {
            return dialog(cfg.strings.linktitle, function(body, submit) {
                var mk = function(label, type, value) {
                    var wrap = document.createElement('label');
                    wrap.className = 'mylkpd-field';
                    wrap.appendChild(document.createTextNode(label));
                    var inp = document.createElement('input');
                    inp.type = type;
                    inp.className = 'form-control';
                    inp.value = value || '';
                    inp.addEventListener('keydown', function(e) {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            submit();
                        }
                    });
                    wrap.appendChild(inp);
                    body.appendChild(wrap);
                    return inp;
                };
                var url = mk(cfg.strings.linkurl, 'url', 'https://');
                var text = mk(cfg.strings.linktext, 'text', initialText);
                var err = document.createElement('div');
                err.className = 'small text-danger';
                body.appendChild(err);
                return function() {
                    var u = url.value.trim();
                    if (u && !/^[a-z]+:/i.test(u)) {
                        u = 'https://' + u;
                    }
                    if (!/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(u)) {
                        err.textContent = cfg.strings.linkinvalid;
                        url.focus();
                        return false;
                    }
                    return {url: u, text: text.value.trim().slice(0, 200)};
                };
            });
        }

        // ---- Equations and links: typed into a paragraph, or placed on the page.

        function editMathChip(chip, blockId) {
            if (!blockEls[blockId] || !blockEls[blockId].isContentEditable) {
                return;
            }
            mathDialog(chip.getAttribute('data-tex')).then(function(tex) {
                if (!tex) {
                    return;
                }
                chip.setAttribute('data-tex', tex);
                renderTex(chip, tex);
                touched[blockId] = true;
                markEdited(blockEls[blockId], cfg.userid);
                scheduleSave();
            });
        }

        function editMathItem(item) {
            mathDialog(item.tex).then(function(tex) {
                if (!tex || tex === item.tex) {
                    return;
                }
                recordUndo([{id: item.id, before: copy(item)}]);
                item.tex = tex;
                renderTex(elems.get(item), tex);
                claim(item);
                changed();
            });
        }

        function placeItem(kind, num, p) {
            var back = prevTool || 'text';
            var ask = kind === 'math' ? mathDialog('') : linkDialog('');
            ask.then(function(v) {
                setTool(back);
                prevTool = null;
                if (!v) {
                    return;
                }
                var it = {id: newId(), page: num, type: kind, x: p.x, y: p.y, color: color, by: cfg.userid};
                if (kind === 'math') {
                    it.tex = v;
                } else {
                    it.url = v.url;
                    it.text = v.text;
                }
                recordUndo([{id: it.id, before: null}]);
                items.push(it);
                createEl(it);
                changed();
            });
        }

        function armPlacement(kind) {
            if (tool !== 'math' && tool !== 'link') {
                prevTool = tool;
            }
            setTool(kind);
        }

        function onInsert(kind, button) {
            if (kind === 'symbol' || kind === 'arabic') {
                togglePanel(kind, button);
                return;
            }
            var inParagraph = canType && tool === 'type';
            if (!inParagraph) {
                armPlacement(kind);
                return;
            }
            if (!focusTarget(true)) {
                flashHint(cfg.strings.needfocus);
                return;
            }
            var range = savedRange;
            var selected = range ? range.toString() : '';
            (kind === 'math' ? mathDialog('') : linkDialog(selected)).then(function(v) {
                if (!v) {
                    focusTarget(true);
                    return;
                }
                savedRange = range;
                if (kind === 'math') {
                    insertNode(mathChip(v));
                } else {
                    var a = document.createElement('a');
                    a.href = v.url;
                    a.textContent = v.text || selected || v.url;
                    insertNode(a);
                }
            });
        }

        // ---- Symbol table and Arabic keyboard (floating panels).

        var panels = {};

        function key(label, title, action) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'mylkpd-key';
            b.textContent = label;
            if (title) {
                b.title = title;
                b.setAttribute('aria-label', title);
            }
            keepFocus(b);
            b.addEventListener('click', action);
            return b;
        }

        function buildPanel(kind) {
            var panel = document.createElement('div');
            panel.className = 'mylkpd-panel mylkpd-panel-' + kind;
            panel.setAttribute('role', 'dialog');
            panel.setAttribute('aria-label', cfg.strings[kind === 'arabic' ? 'arabictitle' : 'symboltitle']);
            keepFocus(panel);
            var head = document.createElement('div');
            head.className = 'mylkpd-panel-head';
            head.textContent = cfg.strings[kind === 'arabic' ? 'arabictitle' : 'symboltitle'];
            head.appendChild(key('\u00d7', cfg.strings.close, function() {
                togglePanel(kind);
            }));
            panel.appendChild(head);
            if (kind === 'symbol') {
                var grid = document.createElement('div');
                grid.className = 'mylkpd-keys mylkpd-symbol-grid';
                SYMBOLS.forEach(function(sym) {
                    grid.appendChild(key(sym, sym, function() {
                        insertText(sym);
                    }));
                });
                panel.appendChild(grid);
            } else {
                ARABIC_ROWS.forEach(function(row) {
                    var r = document.createElement('div');
                    r.className = 'mylkpd-keys mylkpd-arabic-row';
                    r.dir = 'rtl';
                    row.split(' ').forEach(function(ch) {
                        var isMark = /[\u064B-\u0652\u0670]/.test(ch);
                        r.appendChild(key(isMark ? '\u25CC' + ch : ch, null, function() {
                            insertText(ch);
                        }));
                    });
                    panel.appendChild(r);
                });
                var last = document.createElement('div');
                last.className = 'mylkpd-keys mylkpd-arabic-row';
                var space = key(cfg.strings.space, cfg.strings.space, function() {
                    insertText(' ');
                });
                space.classList.add('mylkpd-key-wide');
                last.appendChild(space);
                last.appendChild(key('\u232B', cfg.strings.backspace, deleteBack));
                panel.appendChild(last);
            }
            document.body.appendChild(panel);
            return panel;
        }

        function togglePanel(kind, button) {
            var panel = panels[kind] || (panels[kind] = buildPanel(kind));
            var open = !panel.classList.contains('mylkpd-open');
            Object.keys(panels).forEach(function(k) {
                panels[k].classList.remove('mylkpd-open');
            });
            Array.prototype.forEach.call(document.querySelectorAll('[data-mylkpd-insert="symbol"],[data-mylkpd-insert="arabic"]'),
                function(b) {
                    b.classList.remove('btn-primary');
                    b.classList.add('btn-outline-secondary');
                });
            if (open) {
                panel.classList.add('mylkpd-open');
                if (button) {
                    button.classList.add('btn-primary');
                    button.classList.remove('btn-outline-secondary');
                }
                if (!isTarget(lastTarget)) {
                    flashHint(cfg.strings.needfocus);
                }
            }
        }

        function setupInsertTools() {
            Array.prototype.forEach.call(document.querySelectorAll('[data-mylkpd-insert]'), function(b) {
                keepFocus(b);
                b.addEventListener('click', function() {
                    onInsert(b.getAttribute('data-mylkpd-insert'), b);
                });
            });
            Array.prototype.forEach.call(document.querySelectorAll('[data-mylkpd-format]'), keepFocus);
        }

        // ------------------------------------------------ Toolbar and buttons.

        function setTool(t) {
            tool = t;
            container.className = container.className.replace(/\bmylkpd-mode-\S+/g, '').trim() + ' mylkpd-mode-' + t;
            Array.prototype.forEach.call(document.querySelectorAll('[data-mylkpd-tool]'), function(b) {
                var on = b.getAttribute('data-mylkpd-tool') === t;
                b.classList.toggle('btn-primary', on);
                b.classList.toggle('btn-outline-secondary', !on);
                b.setAttribute('aria-pressed', on ? 'true' : 'false');
            });
            Array.prototype.forEach.call(document.querySelectorAll('[data-mylkpd-insert]'), function(b) {
                var on = b.getAttribute('data-mylkpd-insert') === t;
                b.classList.toggle('btn-primary', on);
                b.classList.toggle('btn-outline-secondary', !on);
            });
            Array.prototype.forEach.call(document.querySelectorAll('[data-mylkpd-format]'), function(b) {
                b.disabled = t !== 'type';
            });
            if (hintEl) {
                hintEl.textContent = (t === 'math' || t === 'link') ? cfg.strings.clicktoplace : hintText;
            }
            updateUndo();
        }

        function warnUnsaved(e) {
            if (inflight || hasPending()) {
                e.preventDefault();
                e.returnValue = '';
            }
        }

        var namesToggle = document.querySelector('[data-mylkpd-names]');
        if (namesToggle) {
            namesToggle.addEventListener('change', function() {
                container.classList.toggle('mylkpd-hide-names', !namesToggle.checked);
            });
        }

        function stickyOffset() {
            var page = document.getElementById('page');
            var overflow = page ? window.getComputedStyle(page).overflowY : '';
            var top = 0;
            if (overflow !== 'auto' && overflow !== 'scroll') {
                var nav = document.querySelector('nav.fixed-top, .navbar.fixed-top');
                if (nav) {
                    top = Math.round(nav.getBoundingClientRect().height);
                }
            }
            document.documentElement.style.setProperty('--mylkpd-sticky-top', top + 'px');
        }

        if (!readonly) {
            stickyOffset();
            window.addEventListener('resize', stickyOffset);
            Array.prototype.forEach.call(document.querySelectorAll('[data-mylkpd-tool]'), function(b) {
                b.addEventListener('click', function() {
                    setTool(b.getAttribute('data-mylkpd-tool'));
                });
            });
            var swatches = document.querySelectorAll('[data-mylkpd-color]');
            Array.prototype.forEach.call(swatches, function(b) {
                b.addEventListener('click', function() {
                    color = b.getAttribute('data-mylkpd-color');
                    Array.prototype.forEach.call(swatches, function(o) {
                        o.classList.toggle('active', o === b);
                        o.setAttribute('aria-pressed', o === b ? 'true' : 'false');
                    });
                });
            });
            var widthSelect = document.querySelector('[data-mylkpd-width]');
            if (widthSelect) {
                widthSelect.addEventListener('change', function() {
                    width = parseInt(widthSelect.value, 10) || 4;
                });
            }
            var undoBtn = document.querySelector('[data-mylkpd-action="undo"]');
            if (undoBtn) {
                undoBtn.addEventListener('mousedown', function(e) {
                    e.preventDefault();
                });
                undoBtn.addEventListener('click', function() {
                    if (tool === 'type') {
                        focusTarget();
                        document.execCommand('undo');
                    } else {
                        // Leave the text box first, so an empty box is cleaned up before undoing.
                        if (document.activeElement && document.activeElement.blur) {
                            document.activeElement.blur();
                        }
                        undo();
                    }
                });
            }
            var redoBtn = document.querySelector('[data-mylkpd-action="redo"]');
            if (redoBtn) {
                redoBtn.addEventListener('mousedown', function(e) {
                    e.preventDefault();
                });
                redoBtn.addEventListener('click', function() {
                    focusTarget();
                    document.execCommand('redo');
                });
            }
            Array.prototype.forEach.call(document.querySelectorAll('[data-mylkpd-format]'), function(b) {
                b.addEventListener('mousedown', function(e) {
                    e.preventDefault(); // Keep the cursor in the paragraph.
                });
                b.addEventListener('click', function() {
                    if (!focusTarget(true)) {
                        flashHint(cfg.strings.needfocus);
                        return;
                    }
                    var cmd = b.getAttribute('data-mylkpd-format');
                    document.execCommand('styleWithCSS', false, true);
                    if (cmd === 'foreColor') {
                        document.execCommand('foreColor', false, color);
                    } else if (cmd === 'hiliteColor') {
                        document.execCommand('hiliteColor', false, '#fff176');
                    } else {
                        document.execCommand(cmd);
                    }
                });
            });
            document.addEventListener('keydown', function(e) {
                var t = e.target || {};
                if (tool !== 'type' && (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' &&
                        t.tagName !== 'TEXTAREA' && t.tagName !== 'INPUT' && !t.isContentEditable) {
                    e.preventDefault();
                    undo();
                }
            });

            var saveBtn = document.querySelector('[data-mylkpd-action="save"]');
            if (saveBtn) {
                saveBtn.addEventListener('click', function() {
                    if (document.activeElement && document.activeElement.blur) {
                        document.activeElement.blur();
                    }
                    saveBtn.disabled = true;
                    setState('saving');
                    // Wait for any request in progress, then send everything that is left.
                    flush().then(function() {
                        return flush();
                    }).then(function() {
                        saveBtn.disabled = false;
                        if (failed || hasPending()) {
                            setState('saveerror');
                            window.alert(cfg.strings.saveerror + (lastError ? '\n\n' + lastError : ''));
                        } else {
                            setState('saved');
                        }
                    });
                });
            }
            var submitBtn = document.querySelector('[data-mylkpd-action="submit"]');
            if (submitBtn) {
                submitBtn.addEventListener('click', function() {
                    if (!window.confirm(cfg.strings.confirmsubmit)) {
                        return;
                    }
                    if (document.activeElement && document.activeElement.blur) {
                        document.activeElement.blur();
                    }
                    submitBtn.disabled = true;
                    flush().then(flush).then(function() {
                        if (failed || hasPending()) {
                            submitBtn.disabled = false;
                            setState('saveerror');
                            window.alert(cfg.strings.saveerror + (lastError ? '\n\n' + lastError : ''));
                            return;
                        }
                        window.removeEventListener('beforeunload', warnUnsaved);
                        document.getElementById('mylkpd-submitfinal').value = '1';
                        submitBtn.form.submit();
                    });
                });
            }

            window.addEventListener('beforeunload', warnUnsaved);
            window.addEventListener('pagehide', function() {
                // Last chance to save when the tab closes.
                if (hasPending() && navigator.sendBeacon) {
                    navigator.sendBeacon(cfg.syncUrl, requestBody(collectOps()));
                }
            });
            if (cfg.collab) {
                setInterval(function() {
                    if (!document.hidden) {
                        flush();
                    }
                }, 3000);
            }
            setTool(tool);
            setupInsertTools();
        }

        // ------------------------------------------------ Start.

        var width0 = Math.min(container.clientWidth || 800, 1200);
        loadKatex(cfg.katexBase).then(function(k) {
            katex = k;
        }, function(err) {
            window.console.warn('MyLKPD: equations unavailable', err);
        }).then(function() {
            return cfg.mode === 'docx' ? renderDocx() : renderPdf(width0);
        }).then(function() {
            rebuild();
            if (cfg.collab) {
                flush(); // Announce presence and fetch anything newer than the page.
            }
        }).catch(function(err) {
            container.textContent = cfg.strings.loaderror;
            var detail = document.createElement('div');
            detail.className = 'small text-muted mt-1';
            detail.textContent = (err && (err.message || err.name)) ? String(err.message || err.name) : String(err);
            container.appendChild(detail);
            window.console.error('MyLKPD:', err);
        });
    }

    return {init: init};
})();
