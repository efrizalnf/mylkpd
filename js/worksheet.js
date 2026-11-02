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
        var editMode = cfg.workmode === 'edit';
        var members = cfg.members || {};
        var items = Array.isArray(cfg.items) ? cfg.items.filter(function(a) {
            return a && typeof a === 'object' && a.page && a.id;
        }) : [];
        var pages = {};
        var elems = new Map();
        var owners = new WeakMap();
        var undoStack = [];
        var tool = 'text';
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
            if (stateEl) {
                stateEl.textContent = key ? cfg.strings[key] : '';
                stateEl.classList.toggle('text-danger', key === 'saveerror');
            }
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
                if (el && el.innerHTML !== shadowBlocks[id]) {
                    ops.push({op: 'put', kind: 'block', id: id, html: el.innerHTML});
                    shadowBlocks[id] = el.innerHTML;
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
                applyRemote(res);
                if (ops.length || stateEl && stateEl.classList.contains('text-danger')) {
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
                        el.innerHTML !== shadowBlocks[id]) {
                    return;
                }
                if (b.html !== undefined && b.html !== el.innerHTML) {
                    el.innerHTML = b.html;
                }
                shadowBlocks[id] = el.innerHTML;
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
                b.disabled = undoStack.length === 0;
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
            if (item.type === 'text' || item.type === 'check' || item.type === 'cross') {
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

                if (tool === 'text' || tool === 'check' || tool === 'cross') {
                    if (targetEl) {
                        return; // Let the student click into an existing box.
                    }
                    e.preventDefault();
                    var it = {id: newId(), page: num, type: tool, x: p.x, y: p.y, color: color};
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
                el.title = cfg.strings.editedby.replace('{name}', memberName(by));
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
                shadowBlocks[id] = p.innerHTML;
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
                if (editMode) {
                    setupBlocks(holder);
                } else {
                    Array.prototype.forEach.call(holder.querySelectorAll('section.docx'), function(section, i) {
                        setupPage(i + 1, section);
                    });
                }
                fit();
                window.addEventListener('resize', fit);
            });
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
        }

        function warnUnsaved(e) {
            if (inflight || hasPending()) {
                e.preventDefault();
                e.returnValue = '';
            }
        }

        if (!readonly) {
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
                undoBtn.addEventListener('click', undo);
            }
            Array.prototype.forEach.call(document.querySelectorAll('[data-mylkpd-format]'), function(b) {
                b.addEventListener('mousedown', function(e) {
                    e.preventDefault(); // Keep the cursor in the paragraph.
                });
                b.addEventListener('click', function() {
                    if (document.activeElement && document.activeElement.isContentEditable) {
                        document.execCommand(b.getAttribute('data-mylkpd-format'));
                    }
                });
            });
            document.addEventListener('keydown', function(e) {
                var t = e.target || {};
                if (!editMode && (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' &&
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
                    flush().then(flush);
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
                            window.alert(cfg.strings.saveerror);
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
            if (!editMode) {
                setTool('text');
            }
        }

        // ------------------------------------------------ Start.

        var width0 = Math.min(container.clientWidth || 800, 1200);
        (cfg.mode === 'docx' ? renderDocx() : renderPdf(width0)).then(function() {
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
