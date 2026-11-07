/*!
 * Vibe Lightbox — full-screen photo viewer: grows out of the thumbnail, pages with a curtain wipe, zooms and pans
 * with inertia, closes back into the thumbnail. No dependencies.
 * MIT License. https://github.com/IvanMayorov/vibe-lightbox
 *
 * Markup: <a data-lightbox="group" href="large.jpg"><img src="thumb.jpg" alt=""></a>. Links of one group page together.
 * VibeLightbox.init(options) starts listening for clicks on such links (see README for options).
 *
 * - The photo grows out of the thumbnail and folds back into it; the thumbnail stays on screen until the large photo loads.
 * - Opens with a click or a two-finger spread on the thumbnail.
 * - Paging: arrows, ←/→ keys, swipe (the curtain follows the finger), thumbnails strip.
 *   Or `paging: 'slide'` — photos slide side by side like a usual carousel, both following the finger.
 * - Zoom: click in steps ×2, ×4… up to natural size; double tap on touch; mouse wheel; pinch on touch screens and touchpads.
 *   A zoomed photo is dragged with inertia and springs back at the edges.
 * - Closing: close button, Esc, click on the backdrop, browser Back (the viewer has its own #group-N address),
 *   swipe up or down on touch.
 * - Event 'vibe-lightbox:close' on document (detail: {group, index, link}) at the start of closing.
 */
(function (root, factory) {
	if (typeof module === 'object' && module.exports) module.exports = factory();
	else root.VibeLightbox = factory();
})(typeof self !== 'undefined' ? self : this, function () {
	'use strict';

	var DEFAULTS = {
		attribute: 'data-lightbox', // links with this attribute open the viewer; its value is the group name
		hash: true,                 // own address #group-N: browser Back closes the viewer, links with the hash open it
		pinchOpen: true,            // two-finger spread on a thumbnail opens the viewer
		paging: 'curtain',          // 'curtain' — curtain wipe; 'slide' — photos slide side by side like a usual carousel
		labels: {
			dialog: 'Photo viewer',
			close: 'Close',
			prev: 'Previous photo',
			next: 'Next photo',
			thumb: 'Photo {n}'
		},
		frame: null,   // function (link) → element the photo folds into on close (default: the link)
		resolve: null, // function (link) → link to open instead, or null to do nothing (for galleries with their own transitions)
		onOpen: null,  // function ({group, index, link})
		onClose: null  // function ({group, index, link}) — at the start of closing
	};

	var opts = null;
	var still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
	var DURATION = still ? 0 : 320;
	var RUBBER = .35; // past the photo edge and past the zoom limits the finger moves the photo ~3 times slower

	var box, track, counter, prevBtn, nextBtn, closeBtn, thumbsBox; // viewer elements
	var links = [], slides = [], thumbs = [], group = '', index = 0, opened = false, closing = false;
	var zoom = { scale: 1, x: 0, y: 0 }; // zoom of the current photo: scale and offset from the centre, px
	var pointers = {}, gesture = null, lastTap = null;
	var shown = { scale: 1, x: 0, y: 0 }, anim = 0, gliding = false; // what is on screen now and the zoom animation frame id

	function el(tag, cls, html) {
		var e = document.createElement(tag);
		if (cls) e.className = cls;
		if (html) e.innerHTML = html;
		return e;
	}
	// Icons are inline SVG: Safari on iPhone did not paint CSS masks on the viewer buttons.
	var ICONS = {
		close: '<path d="M6 6L18 18M18 6L6 18"/>',
		arrow: '<path d="M4 12h16M14 6l6 6-6 6"/>'
	};
	function button(cls, label, icon) {
		var b = el('button', 'vibe-lightbox__btn ' + cls,
			'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[icon] + '</svg>');
		b.type = 'button';
		b.setAttribute('aria-label', label);
		return b;
	}
	function previewSrc(link) {
		var img = link.querySelector('img');
		return img ? (img.currentSrc || img.src) : link.href;
	}
	function selector(name) {
		return 'a[' + opts.attribute + (name != null ? '="' + String(name).replace(/["\\]/g, '\\$&') + '"' : '') + ']';
	}
	function groupLinks(name) {
		return [].slice.call(document.querySelectorAll(selector(name)));
	}
	function info() {
		return { group: group, index: index, link: links[index] };
	}

	function build() {
		box = el('div', 'vibe-lightbox');
		box.setAttribute('role', 'dialog');
		box.setAttribute('aria-modal', 'true');
		box.setAttribute('aria-label', opts.labels.dialog);
		box.appendChild(el('div', 'vibe-lightbox__bg'));
		var stage = el('div', 'vibe-lightbox__stage');
		track = el('div', 'vibe-lightbox__track');
		stage.appendChild(track);
		box.appendChild(stage);
		counter = el('div', 'vibe-lightbox__counter');
		box.appendChild(counter);
		closeBtn = button('vibe-lightbox__btn_close', opts.labels.close, 'close');
		prevBtn = button('vibe-lightbox__btn_prev', opts.labels.prev, 'arrow');
		nextBtn = button('vibe-lightbox__btn_next', opts.labels.next, 'arrow');
		box.appendChild(closeBtn);
		box.appendChild(prevBtn);
		box.appendChild(nextBtn);
		thumbsBox = el('div', 'vibe-lightbox__thumbs');
		box.appendChild(thumbsBox);

		closeBtn.addEventListener('click', function () { requestClose(); });
		prevBtn.addEventListener('click', function () { go(index - 1); });
		nextBtn.addEventListener('click', function () { go(index + 1); });
		stage.addEventListener('pointerdown', down);
		stage.addEventListener('pointermove', move);
		stage.addEventListener('pointerup', up);
		stage.addEventListener('pointercancel', up);
		stage.addEventListener('wheel', wheel, { passive: false });
		// Safari on iPhone does not always respect touch-action: a pinch zoomed the page as well and the photo jittered
		// between the two zooms. Touches and gestures inside the viewer are taken from the browser; pointer events do the rest.
		stage.addEventListener('touchstart', noNative, { passive: false });
		stage.addEventListener('touchmove', noNative, { passive: false });
		stage.addEventListener('dragstart', function (e) { e.preventDefault(); });
		box.addEventListener('keydown', trapFocus);
		document.body.appendChild(box);
	}

	function noNative(e) {
		if (e.cancelable) e.preventDefault();
	}

	// ---------- Opening and closing ----------

	function open(name, start, animate) {
		if (opened) return;
		var list = groupLinks(name);
		if (!list.length) return;
		if (!box) build();
		group = name;
		links = list;
		index = Math.max(0, Math.min(start, links.length - 1));
		opened = true;
		closing = false;

		track.innerHTML = '';
		thumbsBox.innerHTML = '';
		slides = links.map(function (link) {
			var slide = el('div', 'vibe-lightbox__slide');
			var img = el('img', 'vibe-lightbox__img');
			img.alt = (link.querySelector('img') || {}).alt || '';
			img.src = previewSrc(link);
			img.draggable = false;
			slide.appendChild(img);
			track.appendChild(slide);
			var preview = link.querySelector('img');
			var s = { el: slide, img: img, href: link.href, loaded: false, ratio: preview && preview.naturalWidth ? preview.naturalWidth / preview.naturalHeight : 0 };
			// The thumbnail on the page has not loaded yet — a skeleton stands in its place until it does.
			if (!s.ratio) {
				slide.classList.add('is-empty');
				img.addEventListener('load', function () {
					if (!s.ratio) { s.ratio = img.naturalWidth / img.naturalHeight; fit(s); }
					slide.classList.remove('is-empty');
				});
			}
			return s;
		});
		thumbs = links.length > 1 ? links.map(function (link, i) {
			var t = el('button', 'vibe-lightbox__thumb');
			t.type = 'button';
			t.setAttribute('aria-label', opts.labels.thumb.replace('{n}', i + 1));
			t.style.backgroundImage = 'url("' + previewSrc(link).replace(/["\\]/g, '\\$&') + '")';
			t.addEventListener('click', function () { go(i); });
			thumbsBox.appendChild(t);
			return t;
		}) : [];
		box.classList.toggle('vibe-lightbox_single', links.length < 2);

		document.documentElement.classList.add('vibe-lightbox-lock');
		box.classList.add('is-open');
		slides.forEach(fit);
		stack();
		update();
		load(index);

		var img = slides[index].img;
		var from = landing(links[index], slides[index].ratio) || links[index].getBoundingClientRect();
		if (animate && DURATION && from.width) {
			// The photo grows out of the thumbnail: put it over the thumbnail and remove the transform frame by frame.
			var c = center();
			zoom = { scale: from.width / img.offsetWidth, x: from.left + from.width / 2 - c.x, y: from.top + from.height / 2 - c.y };
			draw(img, zoom);
			zoom = { scale: 1, x: 0, y: 0 };
			applyZoom(true);
			// A thumbnail cropped by object-fit: cover — the photo starts cropped the same way and the crop opens up.
			if (from.clip) {
				var t0 = performance.now(), s0 = slides[index];
				crop(img, from.clip, 1);
				(function step(now) {
					if (closing) return;
					if (!opened || slides[index] !== s0) { crop(img); return; }
					var k = Math.min(1, (now - t0) / DURATION);
					crop(img, from.clip, Math.pow(1 - k, 3));
					if (k < 1) requestAnimationFrame(step);
				})(t0);
			}
		}
		setTimeout(function () { closeBtn.focus({ preventScroll: true }); }, DURATION);
		if (opts.onOpen) opts.onOpen(info());
	}

	// Closing from the viewer goes through history.back() so the history does not pile up; the close itself is in popstate.
	function requestClose() {
		if (!opened || closing) return;
		if (opts.hash && history.state && history.state.vibeLightbox) history.back();
		else close();
	}

	function close() {
		if (!opened || closing) return;
		closing = true;
		stack(); // a curtain still running — straight to rest
		var img = slides[index].img;
		var link = links[index];
		var detail = info();
		// Let the page react first (e.g. a gallery switches to this photo), then measure where to fold into.
		document.dispatchEvent(new CustomEvent('vibe-lightbox:close', { detail: detail }));
		if (opts.onClose) opts.onClose(detail);
		var frame = (opts.frame && opts.frame(link)) || link;
		var to = frame.getBoundingClientRect();
		// Fold into the thumbnail only if it is on screen and not covered by anything; otherwise fade out.
		box.style.pointerEvents = 'none'; // the viewer itself lies over the thumbnail — hide it from the hit test
		var hit = to.width && document.elementFromPoint(to.left + to.width / 2, to.top + to.height / 2);
		box.style.pointerEvents = '';
		var visible = hit && to.bottom > 0 && to.top < innerHeight && frame.contains(hit);
		// The photo leaves from where it is now (zoomed, swiped down), frame by frame: a CSS transition flashed white
		// in Safari. The backdrop fades from the opacity it had while being swiped away.
		stopAnim();
		box.classList.add('is-closing');
		var from = shown, c = center();
		// Where the photo lands: the thumbnail image is fitted into its box (object-fit) — compute where it is actually visible,
		// otherwise non-square photos jumped in size at the end.
		var land = (frame === link && landing(link, slides[index].ratio)) || to;
		var target = visible
			? { scale: land.width / img.offsetWidth, x: land.left + land.width / 2 - c.x, y: land.top + land.height / 2 - c.y, o: 1, clip: land.clip }
			: { scale: from.scale * .92, x: from.x, y: from.y + (from.y > 0 ? 80 : from.y < 0 ? -80 : 0), o: 0 };
		var start = performance.now();
		boost(img);
		if (DURATION) (function step(now) {
			var k = Math.min(1, (now - start) / DURATION);
			var e = 1 - Math.pow(1 - k, 3);
			draw(img, { scale: from.scale + (target.scale - from.scale) * e, x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e });
			img.style.opacity = 1 + (target.o - 1) * e;
			crop(img, target.clip, e);
			anim = k < 1 ? requestAnimationFrame(step) : 0;
		})(start);
		setTimeout(function () {
			stopAnim();
			box.style.removeProperty('--vibe-lightbox-fade');
			zoom = { scale: 1, x: 0, y: 0 };
			shown = { scale: 1, x: 0, y: 0 };
			box.classList.remove('is-open', 'is-closing', 'is-zoomable', 'is-zoomed', 'is-busy', 'is-grabbing');
			document.documentElement.classList.remove('vibe-lightbox-lock');
			track.innerHTML = '';
			opened = false;
			closing = false;
		}, DURATION);
	}

	// The rectangle the thumbnail image occupies on the page, taking object-fit (contain / scale-down / cover)
	// and object-position into account. For cover it is the whole uncropped photo, plus `clip` — the part the box cuts off.
	function landing(link, ratio) {
		var pic = link.querySelector('img');
		if (!pic || !ratio) return null;
		var r = pic.getBoundingClientRect();
		if (!r.width || !r.height) return null;
		var cs = getComputedStyle(pic);
		var fit = cs.objectFit;
		if (fit !== 'contain' && fit !== 'scale-down' && fit !== 'cover') return r;
		var w = fit === 'cover' ? Math.max(r.width, r.height * ratio) : Math.min(r.width, r.height * ratio);
		if (fit === 'scale-down') w = Math.min(w, pic.naturalWidth || w);
		var h = w / ratio;
		var pos = cs.objectPosition.split(' ');
		var land = { left: r.left + offset(pos[0], r.width - w), top: r.top + offset(pos[1] || pos[0], r.height - h), width: w, height: h };
		// cover — the photo is larger than the box and cropped by it: remember the crop as shares of the photo
		// (top, right, bottom, left) and the corner radius in px of the photo, so the transition crops the photo the same way.
		if (fit === 'cover') land.clip = {
			t: (r.top - land.top) / h, r: (land.left + w - r.right) / w, b: (land.top + h - r.bottom) / h, l: (r.left - land.left) / w,
			radius: (parseFloat(cs.borderTopLeftRadius) || 0) / w
		};
		return land;
	}
	// Crop the photo like the thumbnail: share e (0…1) of the crop c from landing(). Insets are in px of the photo before transform.
	function crop(img, c, e) {
		if (!c || !e) { img.style.clipPath = ''; return; }
		var W = img.offsetWidth, H = img.offsetHeight;
		img.style.clipPath = 'inset(' + c.t * H * e + 'px ' + c.r * W * e + 'px ' + c.b * H * e + 'px ' + c.l * W * e + 'px' +
			(c.radius ? ' round ' + c.radius * W * e + 'px' : '') + ')';
	}
	// Offset by object-position: percentages are a share of the free space, pixels as they are.
	function offset(value, free) {
		var n = parseFloat(value);
		if (isNaN(n)) return free / 2;
		return /%$/.test(value) ? free * n / 100 : n;
	}

	// ---------- Paging: the curtain ----------
	// The new photo is revealed by a mask from the paging side and slides into place, the old one drifts the other way.
	// On swipe the curtain follows the finger; on release it completes or rolls back.
	// Slides lie on top of each other, the current one is visible. Frame-by-frame animation (CSS transitions flickered in Safari).

	var CURTAIN = still ? 0 : 800; // full change, ms
	var SLIDE = still ? 0 : 380;   // full change in 'slide' paging, ms
	var GAP = 16;                  // space between photos in 'slide' paging, px
	function sliding() { return opts && opts.paging === 'slide'; }
	var SHIFT = .17, DRIFT = .35;  // slide-in of the new photo and drift of the old one, shares of the photo width
	var curtain = null, curtainAnim = 0; // { from, to, dir, p } — the running change and its progress 0…1

	function easeOut(k) { return 1 - Math.pow(1 - k, 3); }

	// Show the curtain at progress p: `to` is revealed by share p from side `dir`, `from` is shifted against `dir`.
	function curtainFrame(c, p) {
		c.p = p;
		var to = slides[c.to], from = slides[c.from];
		if (sliding()) { slideFrame(c, p, from, to); return; }
		// The curtain is a vertical line through the whole viewer height that travels across the photo width.
		// On one side of it — the new photo, on the other — the old one, both cut by this line; nothing shows past the side
		// edges of the frame. The frame width morphs from the old photo to the new one. Zoomed photos (paging with arrows
		// while zoomed) travel zoomed, the frame follows the visible part.
		var a = from.img, b = to.img, W = from.el.clientWidth;
		var fz = c.fromZoom || { scale: 1, x: 0, y: 0 }, tz = c.toZoom || { scale: 1, x: 0, y: 0 };
		function span(img, z) {
			var cx = img.offsetLeft + img.offsetWidth / 2 + z.x, half = img.offsetWidth * z.scale / 2;
			return [Math.max(0, cx - half), Math.min(W, cx + half)];
		}
		var sa = span(a, fz), sb = span(b, tz);
		var L = sa[0] + (sb[0] - sa[0]) * p;
		var R = sa[1] + (sb[1] - sa[1]) * p;
		var X = c.dir > 0 ? R - (R - L) * p : L + (R - L) * p;
		function cut(left, right) { return 'inset(0 ' + (W - right) + 'px 0 ' + left + 'px)'; }
		function zoomed(z) { return z.scale === 1 && !z.x && !z.y ? '' : ' translate(' + z.x + 'px, ' + z.y + 'px) scale(' + z.scale + ')'; }
		to.el.style.visibility = 'visible';
		to.el.style.zIndex = '2';
		to.el.style.clipPath = c.dir > 0 ? cut(X, R) : cut(L, X);
		from.el.style.clipPath = c.dir > 0 ? cut(L, X) : cut(X, R);
		var w = sb[1] - sb[0] || box.clientWidth;
		b.style.transform = 'translateX(' + c.dir * w * SHIFT * (1 - p) + 'px)' + zoomed(tz);
		a.style.transform = 'translateX(' + -c.dir * (sa[1] - sa[0] || w) * DRIFT * p + 'px)' + zoomed(fz);
	}

	// 'slide' paging: the old photo moves out and the new one moves in next to it, both following the finger.
	function slideFrame(c, p, from, to) {
		function zoomed(z) { return !z || (z.scale === 1 && !z.x && !z.y) ? '' : 'translate(' + z.x + 'px, ' + z.y + 'px) scale(' + z.scale + ')'; }
		var step = from.el.clientWidth + GAP;
		to.el.style.visibility = 'visible';
		to.el.style.zIndex = '2';
		from.el.style.clipPath = to.el.style.clipPath = '';
		from.el.style.transform = 'translateX(' + -c.dir * step * p + 'px)';
		to.el.style.transform = 'translateX(' + c.dir * step * (1 - p) + 'px)';
		from.img.style.transform = zoomed(c.fromZoom);
		to.img.style.transform = zoomed(c.toZoom);
	}

	// All slides at rest: only the current one is visible.
	function stack() {
		cancelAnimationFrame(curtainAnim);
		curtainAnim = 0;
		curtain = null;
		slides.forEach(function (s, k) {
			var on = k === index;
			s.el.style.visibility = on ? 'visible' : 'hidden';
			s.el.style.zIndex = on ? '1' : '0';
			s.el.style.clipPath = '';
			s.el.style.transform = '';
			s.img.style.clipPath = '';
			if (!on) s.img.style.transform = '';
		});
		if (slides[index]) draw(slides[index].img, shown);
	}

	// Run the curtain to p = target, then call done.
	function curtainTo(c, target, done) {
		cancelAnimationFrame(curtainAnim);
		var full = sliding() ? SLIDE : CURTAIN;
		var from = c.p, dur = Math.max(120, full * Math.abs(target - from)), start = performance.now();
		if (!full) { curtainFrame(c, target); done(); return; }
		(function step(now) {
			var k = Math.min(1, (now - start) / dur);
			curtainFrame(c, from + (target - from) * easeOut(k));
			if (k < 1) curtainAnim = requestAnimationFrame(step);
			else { curtainAnim = 0; done(); }
		})(start);
	}

	function go(i) {
		if (!opened || i < 0 || i >= slides.length || i === index) {
			cancelSwipe();
			return;
		}
		// A curtain started by a swipe towards this slide continues from where it was released; a previous change still
		// running, or a swipe the other way, goes straight to rest.
		var c = curtain;
		if (c && (c.committed || c.to !== i)) { stack(); c = null; }
		stopAnim();
		if (!c) c = { from: index, to: i, dir: i > index ? 1 : -1, p: 0 };
		// Paging a zoomed photo (arrows, keys, thumbnails) — the next one opens zoomed too, at the same scale
		// (not beyond its natural size), centred.
		c.fromZoom = { scale: shown.scale, x: shown.x, y: shown.y };
		c.toZoom = { scale: 1, x: 0, y: 0 };
		if (shown.scale > 1.05) c.toZoom.scale = Math.min(shown.scale, maxScale(slides[i]));
		c.committed = true;
		curtain = c;
		index = i;
		zoom = { scale: c.toZoom.scale, x: 0, y: 0 };
		shown = { scale: zoom.scale, x: 0, y: 0 };
		update();
		load(index);
		if (opts.hash && history.state && history.state.vibeLightbox) history.replaceState(history.state, '', '#' + group + '-' + (index + 1));
		curtainTo(c, 1, function () { stack(); updateCursor(); });
	}

	// Swipe with a finger or mouse: the curtain towards the neighbour follows the hand; at the first/last photo — only a resisting shift.
	function swipeTo(dx) {
		var dir = dx < 0 ? 1 : -1;
		var to = index + dir;
		if (to < 0 || to >= slides.length) {
			if (curtain) stack();
			slides[index].el.style.transform = 'translateX(' + dx / 3 + 'px)';
			return;
		}
		if (curtain && curtain.to !== to) stack(); // the finger crossed to the other side
		if (!curtain) curtain = { from: index, to: to, dir: dir, p: 0 };
		var span = sliding() ? box.clientWidth + GAP : (slides[curtain.to].img.offsetWidth || box.clientWidth);
		curtainFrame(curtain, Math.min(1, Math.abs(dx) / span));
	}

	// Released before paging — the curtain rolls back, the slide returns to its place.
	function cancelSwipe() {
		var c = curtain;
		if (c && !c.committed) {
			curtainTo(c, 0, stack);
			return;
		}
		if (!c && slides[index] && slides[index].el.style.transform) {
			var el = slides[index].el, m = /-?[\d.]+/.exec(el.style.transform), x0 = m ? +m[0] : 0, start = performance.now();
			(function step(now) {
				var k = Math.min(1, (now - start) / Math.max(1, DURATION));
				el.style.transform = k < 1 ? 'translateX(' + x0 * (1 - easeOut(k)) + 'px)' : '';
				if (k < 1) curtainAnim = requestAnimationFrame(step);
			})(start);
		}
	}

	function update() {
		counter.textContent = (index + 1) + ' / ' + slides.length;
		busy();
		prevBtn.disabled = index === 0;
		nextBtn.disabled = index === slides.length - 1;
		thumbs.forEach(function (t, k) {
			t.classList.toggle('is-active', k === index);
			if (k === index) t.scrollIntoView({ block: 'nearest', inline: 'nearest' });
		});
	}

	// Loading bar at the top — until the large photo of the current slide arrives.
	function busy() {
		box.classList.toggle('is-busy', !!slides[index] && !slides[index].done);
	}

	// Large photo of the current slide and its neighbours; the thumbnail stays on screen until the large one loads.
	function load(i) {
		[i, i + 1, i - 1].forEach(function (k) {
			var s = slides[k];
			if (!s || s.loaded) return;
			s.loaded = true;
			var full = new Image();
			full.onload = function () {
				if (!opened || slides[k] !== s) return;
				s.img.src = s.href;
				s.img.classList.add('is-full');
				if (!s.ratio) s.ratio = full.naturalWidth / full.naturalHeight;
				s.natural = full.naturalWidth;
				fit(s);
				s.done = true;
				if (k === index) { updateCursor(); busy(); }
			};
			// The large photo failed — the thumbnail stays, the loading bar goes.
			full.onerror = function () {
				if (!opened || slides[k] !== s) return;
				s.done = true;
				if (k === index) busy();
			};
			full.src = s.href;
		});
	}

	// The photo size is computed from the thumbnail proportions: the thumbnail is shown at full size right away and
	// the large photo replaces it without a jump. Never stretched beyond natural size.
	function fit(s) {
		if (!s.ratio) return;
		var cs = getComputedStyle(s.el);
		var w = s.el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
		var h = s.el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
		var width = Math.min(w, h * s.ratio, s.natural || Infinity);
		s.img.style.width = width + 'px';
		s.img.style.height = width / s.ratio + 'px';
	}

	// ---------- Zoom ----------

	// How much the photo can be enlarged: up to the natural size of the large photo.
	function maxScale(s) {
		var img = (s || slides[index]).img;
		if (!img.offsetWidth) return 1;
		// Until the large photo arrives, zoom still works (on the thumbnail, up to ×3) instead of doing nothing.
		if (!img.classList.contains('is-full')) return 3;
		return Math.max(1, img.naturalWidth / img.offsetWidth);
	}
	function zoomable() { return maxScale() > 1.1; }

	// Click zooms in steps: ×2, ×4… up to natural size; at the last step — back.
	function nextStep() {
		var max = maxScale();
		if (max <= 1.1 || zoom.scale >= max - .01) return 1;
		var step = 2;
		while (step <= zoom.scale + .01) step *= 2;
		return step * 1.3 > max ? max : step; // little left to natural size — go straight to it
	}

	// Double tap: on a phone the photo is shorter than the screen and at ×2 it may still not overflow vertically, so it could
	// not move towards the tap point. Zoom so that the photo fills the screen in both directions with a margin.
	function tapScale() {
		var img = slides[index].img, stage = slides[index].el;
		var fill = Math.max(stage.clientWidth / img.offsetWidth, stage.clientHeight / img.offsetHeight) * 1.6;
		return Math.min(maxScale(), Math.max(2, fill));
	}

	// Wheel and touchpad pinch (wheel with ctrlKey) — smooth zoom at the cursor.
	function wheel(e) {
		if (!opened || closing) return;
		e.preventDefault();
		var max = maxScale();
		if (max <= 1.1) return;
		stopGlide();
		var dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
		var scale = Math.max(1, Math.min(max, zoom.scale * Math.exp(-dy * (e.ctrlKey ? .01 : .002))));
		if (scale === zoom.scale) return;
		zoomTo(scale, e.clientX, e.clientY, false);
		if (scale === 1) resetZoom(false);
	}

	function updateCursor() {
		// Cursor: whole photo — magnifier (a click zooms), zoomed — hand (CSS).
		box.classList.toggle('is-zoomable', zoomable() && nextStep() > 1 && zoom.scale === 1);
		box.classList.toggle('is-zoomed', zoom.scale > 1);
	}

	// Offset limits: the edges of a zoomed photo do not leave the viewer edges.
	// soft — while dragging: the photo can go past the edge with resistance (rubber band), settle() brings it back.
	function bounds() {
		var img = slides[index].img;
		var stage = slides[index].el;
		return {
			x: Math.max(0, (img.offsetWidth * zoom.scale - stage.clientWidth) / 2),
			y: Math.max(0, (img.offsetHeight * zoom.scale - stage.clientHeight) / 2)
		};
	}
	function clamp(soft) {
		var b = bounds();
		zoom.x = soft ? rubber(zoom.x, -b.x, b.x) : Math.max(-b.x, Math.min(b.x, zoom.x));
		zoom.y = soft ? rubber(zoom.y, -b.y, b.y) : Math.max(-b.y, Math.min(b.y, zoom.y));
	}
	// Offset "before resistance": a photo past the edge (after a pinch or during the spring) is picked up from the same spot.
	function raw() {
		var b = bounds();
		return { x: unrubber(zoom.x, b.x), y: unrubber(zoom.y, b.y) };
	}
	function unrubber(v, m) {
		if (v > m) return m + (v - m) / RUBBER;
		if (v < -m) return -m + (v + m) / RUBBER;
		return v;
	}
	function rubber(v, min, max) {
		if (v < min) return min - (min - v) * RUBBER;
		if (v > max) return max + (v - max) * RUBBER;
		return v;
	}

	// ---------- Drawing and zoom animation ----------
	// Zoom is animated frame by frame (requestAnimationFrame), not with a CSS transition: Safari on iPhone repainted
	// the layer of a zoomed photo when a transition started, leaving a white frame.

	function draw(img, z) {
		shown = { scale: z.scale, x: z.x, y: z.y };
		img.style.transition = 'none';
		img.style.transform = z.scale === 1 && !z.x && !z.y ? '' : 'translate(' + z.x + 'px, ' + z.y + 'px) scale(' + z.scale + ')';
	}

	// While the photo shrinks (zoom reset, closing) it is on its own layer (will-change): otherwise Safari on iPhone
	// re-rasterised the large photo every frame at ~15 fps. The layer is removed afterwards — a zoomed photo would stay blurry.
	var boosted = null;

	function boost(img) {
		unboost();
		img.style.willChange = 'transform';
		boosted = img;
	}

	function unboost() {
		if (boosted) boosted.style.willChange = '';
		boosted = null;
	}

	function stopAnim() {
		var was = !!anim;
		cancelAnimationFrame(anim);
		anim = 0;
		gliding = false;
		unboost();
		return was;
	}

	// Show `zoom`: at once or with a smooth transition from what is on screen now.
	function applyZoom(animate, duration) {
		stopAnim();
		var dur = duration || DURATION;
		var img = slides[index].img;
		updateCursor();
		if (!animate || !DURATION) { draw(img, zoom); return; }
		var from = shown, to = { scale: zoom.scale, x: zoom.x, y: zoom.y }, start = performance.now();
		if (to.scale < from.scale) boost(img);
		(function step(now) {
			var k = Math.min(1, (now - start) / dur);
			var e = 1 - Math.pow(1 - k, 3);
			draw(img, { scale: from.scale + (to.scale - from.scale) * e, x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e });
			anim = k < 1 ? requestAnimationFrame(step) : 0;
			if (!anim) unboost();
		})(start);
	}

	// Scale with a fixed point (px, py) on screen.
	function zoomTo(scale, px, py, animate, soft) {
		var c = center();
		var k = scale / zoom.scale;
		zoom.x = (px - c.x) - (px - c.x - zoom.x) * k;
		zoom.y = (py - c.y) - (py - c.y - zoom.y) * k;
		zoom.scale = scale;
		if (scale === 1 && !soft) { zoom.x = 0; zoom.y = 0; }
		clamp(soft);
		applyZoom(animate);
	}

	// Centre of the photo without transform.
	function center() {
		var s = slides[index].el.getBoundingClientRect();
		var img = slides[index].img;
		return { x: s.left + img.offsetLeft + img.offsetWidth / 2, y: s.top + img.offsetTop + img.offsetHeight / 2 };
	}

	function resetZoom(animate) {
		stopAnim();
		if (zoom.scale === 1 && !zoom.x && !zoom.y && shown.scale === 1 && !shown.x && !shown.y) return;
		zoom = { scale: 1, x: 0, y: 0 };
		applyZoom(animate);
	}

	// ---------- Inertia and spring ----------
	// Like iOS scrolling: a photo released on the move glides and slows down by friction; past the edge a spring
	// (no oscillation) pulls it back, so a fast photo slightly overshoots the edge and softly returns.

	var FRICTION = .997; // share of velocity left after 1 ms
	var SPRING = .02;    // spring stiffness at the edge, 1/ms

	// Finger velocity, px/ms — over the last ~100 ms rather than the last event: fingers slow down before release.
	function trackVelocity(g, x, y) {
		var now = performance.now();
		g.trail = (g.trail || []).filter(function (p) { return now - p.t < 120; });
		g.trail.push({ t: now, x: x, y: y });
	}
	function velocity(g) {
		var trail = g.trail || [], now = performance.now();
		if (trail.length < 2 || now - trail[trail.length - 1].t > 100) return { x: 0, y: 0 }; // finger stopped before release
		var a = trail[0], b = trail[trail.length - 1], dt = Math.max(16, b.t - a.t);
		return { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt };
	}

	// Photo released: scale goes back within limits smoothly, offset — with inertia and spring.
	function settle(px, py, vx, vy) {
		var max = maxScale();
		if (zoom.scale < 1.05) { resetZoom(true); return; }
		if (zoom.scale > max) {
			var c = center();
			if (px == null) { px = c.x + zoom.x; py = c.y + zoom.y; }
			var k = max / zoom.scale;
			zoom.x = (px - c.x) - (px - c.x - zoom.x) * k;
			zoom.y = (py - c.y) - (py - c.y - zoom.y) * k;
			zoom.scale = max;
			clamp();
			applyZoom(true, DURATION * 1.6); // back to the zoom limit — slower than usual
			return;
		}
		glide(vx || 0, vy || 0);
	}

	function glide(vx, vy) {
		stopAnim();
		var img = slides[index].img;
		var b = bounds();
		var ax = { p: zoom.x, v: Math.max(-4, Math.min(4, vx)), m: b.x };
		var ay = { p: zoom.y, v: Math.max(-4, Math.min(4, vy)), m: b.y };
		var last = performance.now();
		if (!DURATION) { clamp(); draw(img, zoom); return; }
		(function step(now) {
			var dt = Math.min(32, now - last);
			last = now;
			var moving = axis(ax, dt) | axis(ay, dt);
			zoom.x = ax.p;
			zoom.y = ay.p;
			draw(img, zoom);
			anim = moving ? requestAnimationFrame(step) : 0;
			gliding = !!anim;
		})(last);
	}

	// One axis: within limits — friction, past the edge — spring. Returns whether it is still moving.
	function axis(a, dt) {
		var edge = a.p > a.m ? a.m : a.p < -a.m ? -a.m : null;
		if (edge === null) {
			a.v *= Math.pow(FRICTION, dt);
			a.p += a.v * dt;
		} else {
			// Critically damped spring: x'' = −ω²·d − 2ω·x'
			var d = a.p - edge;
			a.v += (-SPRING * SPRING * d - 2 * SPRING * a.v) * dt;
			a.p += a.v * dt;
			if (Math.abs(a.p - edge) < .5 && Math.abs(a.v) < .02) { a.p = edge; a.v = 0; }
		}
		return Math.abs(a.v) > .01;
	}

	// A finger lands on the photo during inertia or spring — the photo stops where it is.
	// Returns true only if inertia was stopped: then the touch only brakes. A running zoom transition also freezes,
	// but the touch counts — otherwise a quick second double tap was lost.
	function stopGlide() {
		var was = gliding;
		if (!stopAnim()) return false;
		zoom = { scale: shown.scale, x: shown.x, y: shown.y };
		return was;
	}

	// ---------- Fingers and mouse ----------
	// Tap on the photo — zoom, tap on the backdrop — close; drag sideways — page, up/down (finger) — close,
	// zoomed photo — pan; two fingers — pinch.

	function down(e) {
		if (!opened || closing || e.button > 0) return;
		try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
		var stopped = stopGlide();
		pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
		var ids = Object.keys(pointers);
		if (ids.length === 2) {
			var a = pointers[ids[0]], b = pointers[ids[1]];
			// The first finger already dragged the curtain or the photo down — put them back, or the pinch starts shifted.
			if (gesture && gesture.type === 'swipe') stack();
			if (gesture && gesture.type === 'dismiss') box.style.removeProperty('--vibe-lightbox-fade');
			applyZoom(false);
			// Everything is measured from the pinch start, not from the previous frame: otherwise resistance past the edge
			// accumulated every frame and the photo bounced at the zoom limit.
			gesture = { type: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), scale: zoom.scale, x0: zoom.x, y0: zoom.y, mx0: (a.x + b.x) / 2, my0: (a.y + b.y) / 2, moved: true };
		} else if (ids.length === 1) {
			var r = raw();
			gesture = { type: null, x: e.clientX, y: e.clientY, zx: r.x, zy: r.y, t: Date.now(), moved: false, target: e.target, touch: e.pointerType !== 'mouse', stopped: stopped };
		}
	}

	function move(e) {
		if (!gesture || !pointers[e.pointerId]) return;
		// The mouse button was released where pointerup did not arrive (context menu, window edge) — stop following the cursor.
		if (e.pointerType === 'mouse' && !e.buttons) { up(e); return; }
		pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
		if (gesture.type === 'pinch') {
			var ids = Object.keys(pointers);
			if (ids.length < 2) return;
			var a = pointers[ids[0]], b = pointers[ids[1]];
			// Below the original and above the natural size the pinch still goes, with resistance.
			var max = maxScale();
			var rawScale = gesture.scale * Math.hypot(a.x - b.x, a.y - b.y) / gesture.dist;
			var scale = rawScale < 1 ? 1 - (1 - rawScale) * RUBBER : rawScale > max ? max * Math.pow(rawScale / max, RUBBER) : rawScale;
			// The photo point that was between the fingers at the pinch start stays between them: scale and move at once.
			var c = center();
			var k = scale / gesture.scale;
			gesture.mx = (a.x + b.x) / 2;
			gesture.my = (a.y + b.y) / 2;
			zoom.scale = scale;
			zoom.x = (gesture.mx - c.x) - (gesture.mx0 - c.x - gesture.x0) * k;
			zoom.y = (gesture.my - c.y) - (gesture.my0 - c.y - gesture.y0) * k;
			// During a pinch the photo follows the fingers strictly, without edge limits; the spring brings it back on release.
			applyZoom(false);
			return;
		}
		var dx = e.clientX - gesture.x, dy = e.clientY - gesture.y;
		if (!gesture.moved && Math.hypot(dx, dy) < (gesture.touch ? 10 : 6)) return; // a tapping finger jitters a little
		gesture.moved = true;
		if (!gesture.type) {
			if (zoom.scale > 1) { gesture.type = 'pan'; box.classList.add('is-grabbing'); }
			else if (gesture.touch && Math.abs(dy) > Math.abs(dx)) gesture.type = 'dismiss';
			else gesture.type = 'swipe';
		}
		if (gesture.type === 'pan') {
			trackVelocity(gesture, e.clientX, e.clientY);
			zoom.x = gesture.zx + dx;
			zoom.y = gesture.zy + dy;
			clamp(true);
			applyZoom(false);
		} else if (gesture.type === 'swipe') {
			swipeTo(dx);
		} else if (gesture.type === 'dismiss') {
			draw(slides[index].img, { scale: 1, x: 0, y: dy });
			box.style.setProperty('--vibe-lightbox-fade', Math.max(0, 1 - Math.abs(dy) / 400));
		}
	}

	function up(e) {
		if (!pointers[e.pointerId]) return;
		delete pointers[e.pointerId];
		var g = gesture;
		if (!g) return;
		if (g.type === 'pinch') {
			// The second finger is still down — it pans the photo from now on; the scale returns within limits when it lifts
			// too (otherwise the first finger movement cut the smooth return with a jerk).
			var rest = pointers[Object.keys(pointers)[0]];
			if (!rest) { settle(g.mx, g.my); gesture = null; return; }
			var r = raw();
			gesture = { type: 'pan', x: rest.x, y: rest.y, zx: r.x, zy: r.y, moved: true, mx: g.mx, my: g.my };
			return;
		}
		gesture = null;
		var dx = e.clientX - g.x, dy = e.clientY - g.y, fast = Date.now() - g.t < 300;
		if (!g.moved) {
			if (e.type === 'pointercancel') return;
			if (g.stopped && g.touch) { settle(); return; } // the tap stopped inertia — nothing more
			if (g.target.classList.contains('vibe-lightbox__img')) {
				// Finger — double tap: zoom to the tap point or back to the whole photo; a single tap does nothing.
				// Mouse — click in steps ×2, ×4… up to natural size.
				if (g.touch) {
					var now = performance.now();
					if (!lastTap || now - lastTap.t > 350 || Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) > 40) {
						lastTap = { t: now, x: e.clientX, y: e.clientY };
						return;
					}
					lastTap = null;
					if (zoom.scale > 1.05) resetZoom(true);
					else if (zoomable()) zoomTo(tapScale(), e.clientX, e.clientY, true);
					return;
				}
				var next = nextStep();
				if (next === 1) resetZoom(true);
				else zoomTo(next, e.clientX, e.clientY, true);
			} else {
				requestClose();
			}
			return;
		}
		box.classList.remove('is-grabbing');
		if (g.type === 'pan') {
			trackVelocity(g, e.clientX, e.clientY);
			var v = velocity(g);
			settle(g.mx, g.my, v.x, v.y);
		} else if (g.type === 'swipe') {
			// The curtain was pulled a quarter of the screen or flicked fast — page, otherwise roll back.
			var far = box.clientWidth / 4;
			if (dx < -far || (fast && dx < -20)) go(index + 1);
			else if (dx > far || (fast && dx > 20)) go(index - 1);
			else cancelSwipe();
		} else if (g.type === 'dismiss') {
			if (Math.abs(dy) > 120 || (fast && Math.abs(dy) > 40)) {
				requestClose();
			} else {
				box.style.removeProperty('--vibe-lightbox-fade');
				zoom = { scale: 1, x: 0, y: 0 };
				applyZoom(true);
			}
		}
	}

	// ---------- Keys ----------

	function trapFocus(e) {
		if (e.key !== 'Tab') return;
		var items = [].slice.call(box.querySelectorAll('button:not([disabled])')).filter(function (b) { return b.offsetParent; });
		if (!items.length) return;
		var first = items[0], last = items[items.length - 1];
		if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
		else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
	}

	function onKey(e) {
		if (!opened || closing) return;
		if (e.key === 'Escape') { e.preventDefault(); requestClose(); }
		else if (e.key === 'ArrowLeft') { e.preventDefault(); go(index - 1); }
		else if (e.key === 'ArrowRight') { e.preventDefault(); go(index + 1); }
	}

	// ---------- Links, address and window size ----------

	function openLink(link, animate) {
		if (opts.resolve) {
			link = opts.resolve(link);
			if (!link) return;
		}
		var name = link.getAttribute(opts.attribute);
		var i = groupLinks(name).indexOf(link);
		if (i < 0) return;
		if (opts.hash) history.pushState({ vibeLightbox: true }, '', '#' + name + '-' + (i + 1));
		open(name, i, animate !== false);
	}

	function onClick(e) {
		var link = e.target.closest && e.target.closest(selector());
		if (!link || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
		e.preventDefault();
		openLink(link);
	}

	// Two fingers spread on a thumbnail — open the viewer (the page is not zoomed meanwhile).
	var pinchStart = null;
	function spread(touches) {
		return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
	}
	function onTouchStart(e) {
		pinchStart = null;
		if (!opts.pinchOpen || opened || e.touches.length !== 2) return;
		var link = e.touches[0].target.closest && e.touches[0].target.closest(selector());
		if (link && link.contains(e.touches[1].target)) pinchStart = { link: link, start: spread(e.touches) };
	}
	function onTouchMove(e) {
		// The fingers that opened the viewer are still down and still "on the page" — do not zoom the page with them.
		if (opened) { if (e.touches.length > 1 && e.cancelable) e.preventDefault(); return; }
		if (!pinchStart || e.touches.length !== 2) return;
		if (e.cancelable) e.preventDefault();
		if (spread(e.touches) > pinchStart.start * 1.15) {
			var link = pinchStart.link;
			pinchStart = null;
			openLink(link);
		}
	}
	function onTouchEnd(e) {
		if (e.touches.length < 2) pinchStart = null;
	}
	function onGesture(e) {
		if (opened || pinchStart) e.preventDefault();
	}

	function onPopState() {
		if (opened) close();
		else openFromHash();
	}

	// A link with #gallery-3 opens the viewer on the third photo straight away.
	function openFromHash() {
		if (!opts.hash) return;
		var m = location.hash.match(/^#(.+)-(\d+)$/);
		if (!m) return;
		var name = decodeURIComponent(m[1]);
		if (!document.querySelector(selector(name))) return;
		// Underneath the viewer — the same page without the hash, so Back and the close button close it instead of leaving.
		history.replaceState(null, '', location.pathname + location.search);
		history.pushState({ vibeLightbox: true }, '', m[0]);
		open(name, +m[2] - 1, false);
	}

	function onResize() {
		if (!opened) return;
		resetZoom(false);
		slides.forEach(fit);
		stack();
		updateCursor();
	}

	function listeners() {
		return [
			[document, 'click', onClick],
			[document, 'keydown', onKey],
			[document, 'touchstart', onTouchStart, { passive: true }],
			[document, 'touchmove', onTouchMove, { passive: false }],
			[document, 'touchend', onTouchEnd],
			[document, 'gesturestart', onGesture, { passive: false }],
			[document, 'gesturechange', onGesture, { passive: false }],
			[document, 'gestureend', onGesture, { passive: false }],
			[window, 'popstate', onPopState],
			[window, 'resize', onResize]
		];
	}

	function merge(base, extra) {
		var out = {}, k;
		for (k in base) out[k] = base[k];
		for (k in extra || {}) if (extra[k] !== undefined) out[k] = extra[k];
		return out;
	}

	var api = {
		// Start listening for clicks on [data-lightbox] links. Calling it again updates the options.
		init: function (options) {
			var first = !opts;
			options = options || {};
			opts = merge(DEFAULTS, options);
			opts.labels = merge(DEFAULTS.labels, options.labels);
			if (box) box.parentNode.removeChild(box), box = null; // rebuilt with the new labels on next open
			if (first) {
				listeners().forEach(function (l) { l[0].addEventListener(l[1], l[2], l[3]); });
				if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', openFromHash);
				else openFromHash();
			}
			return api;
		},
		// Open a group programmatically: open('gallery', 2) — the third photo; open(linkElement) — from that link.
		open: function (target, start) {
			if (!opts) api.init();
			if (opened) return;
			if (target && target.nodeType === 1) openLink(target);
			else {
				var name = String(target), list = groupLinks(name);
				if (!list.length) return;
				var i = Math.max(0, Math.min(start || 0, list.length - 1));
				if (opts.hash) history.pushState({ vibeLightbox: true }, '', '#' + name + '-' + (i + 1));
				open(name, i, true);
			}
		},
		close: function () { requestClose(); },
		next: function () { go(index + 1); },
		prev: function () { go(index - 1); },
		goTo: function (i) { go(i); },
		isOpen: function () { return opened; },
		destroy: function () {
			if (!opts) return;
			if (opened) {
				opened = false;
				closing = false;
				document.documentElement.classList.remove('vibe-lightbox-lock');
			}
			stopAnim();
			cancelAnimationFrame(curtainAnim);
			listeners().forEach(function (l) { l[0].removeEventListener(l[1], l[2], l[3]); });
			document.removeEventListener('DOMContentLoaded', openFromHash);
			if (box && box.parentNode) box.parentNode.removeChild(box);
			box = null;
			opts = null;
		}
	};

	return api;
});
