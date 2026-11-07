// Startclip site: the load sequence, the film and its chain, and the clone card. It fetches nothing but its own files.
window.startclipSite = true;
const root = document.documentElement;
const $ = id => document.getElementById(id);

// The wall behind the hook: made-up commands from the demo map (tests/support/demo-map.json), never a real map's.
const COMMANDS = [
  'bash ~/models/serve-orbit-35b.sh',
  'cd ~/Projects/ledger; and docker compose up -d',
  'bash ~/labstack/stack.sh up --parser',
  'bash ~/imageserver/start-upscale.sh',
  'bash ~/gate/start_gate_server.sh',
  '~/.local/bin/scribe',
  'bash ~/budget/start.sh',
  'bash ~/cedar-small-gpu/prebuilt/cedar-linux-x64-runtime-12.4-dcc3be7/serve-12gb.sh',
  'bash ~/models/run-switcher.sh',
  '/usr/bin/codestudio',
  'bash ~/bookshelf/start_bookshelf.sh',
  '/usr/bin/demo-engine',
];

// The film's two cuts. `hook` is where the film picks up once the page has played its hook.
const CUTS = {
  wide: {
    file: 'media/film-16x9.mp4',
    poster: 'media/poster-16x9.jpg',
    hook: 4,
    chapters: [['You forgot', 0], ['Click a card', 12.5], ['Nothing runs', 21], ['Drawn for you', 24], ['Port clashes', 39], ['Copy-only', 45.5]],
  },
  tall: {
    file: 'media/film-9x16.mp4',
    poster: 'media/poster-9x16.jpg',
    hook: 3.5,
    chapters: [['You forgot', 0], ['Click a card', 3.5], ['Nothing runs', 8], ['Drawn for you', 10], ['Startclip', 13]],
  },
};

// ---------- the wall: every command, and one empty prompt
const wall = document.querySelector('.wall');
const rows = document.createElement('div');
rows.className = 'wall__rows';
COMMANDS.forEach(command => {
  const row = document.createElement('div');
  row.className = 'row';
  for (let k = 0; k < 8; k++) {
    const part = document.createElement('span');
    part.textContent = '$ ' + command;
    row.append(part);
  }
  rows.append(row);
});
const prompt = document.createElement('div');
prompt.className = 'row row--prompt';
prompt.textContent = '$';
const cursor = document.createElement('i');
prompt.append(cursor);
rows.insertBefore(prompt, rows.children[5]);
wall.append(rows);

// ---------- the cut stays clear of the pitch: as low as the content needs, at the mark's slope
const hero = document.querySelector('.hero');
const stacked = matchMedia('(max-width: 1040px)');
function fitCut() {
  const box = hero.getBoundingClientRect();
  const end = document.querySelector('.get').getBoundingClientRect();
  const clear = end.bottom - box.top + 0.32 * (end.right - box.left) + 30;
  hero.style.setProperty('--left', Math.round(stacked.matches ? end.bottom - box.top + 0.32 * innerWidth + 26 : Math.max(clear, innerHeight * 0.95)) + 'px');
}
addEventListener('resize', fitCut);
document.fonts.ready.then(fitCut);
fitCut();

// ---------- the film
const film = $('film');
const video = $('video');
const toggle = $('toggle');
const sound = $('sound');
const chain = $('chain');
const tall = matchMedia('(max-width: 700px)');
const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
const saveData = !!navigator.connection?.saveData || matchMedia('(prefers-reduced-data: reduce)').matches;
const auto = !calm && !saveData;
let cut = tall.matches ? CUTS.tall : CUTS.wide;
let stops = [];
let armed = false;   // the load sequence has handed over to the film
let inView = false;
let held = false;    // the viewer paused it, or it ended
let started = false;

function buildChain() {
  chain.replaceChildren();
  stops = cut.chapters.map(([label, t]) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', () => {
      held = false;
      video.currentTime = t;
      video.play().catch(() => {});
    });
    li.append(button);
    chain.append(li);
    return { li, button, t };
  });
}

function useCut(from) {
  video.src = cut.file + (from ? '#t=' + from : '');
  video.poster = cut.poster;
  video.preload = auto ? 'auto' : 'none';
  buildChain();
  trace();
}

function trace() {
  const now = video.currentTime;
  const end = video.duration || stops[stops.length - 1].t;
  stops.forEach((stop, i) => {
    const next = i + 1 < stops.length ? stops[i + 1].t : end;
    const fill = Math.min(1, Math.max(0, (now - stop.t) / (next - stop.t)));
    stop.li.style.setProperty('--fill', fill.toFixed(4));
    stop.li.classList.toggle('on', started && now >= stop.t);
    const current = started && now >= stop.t && now < next;
    if (current) stop.button.setAttribute('aria-current', 'true');
    else stop.button.removeAttribute('aria-current');
  });
}
function following() {
  trace();
  if (!video.paused) requestAnimationFrame(following);
}

function showState() {
  toggle.textContent = !video.paused ? 'Pause' : video.ended ? 'Play again' : 'Play film';
  film.classList.toggle('idle', video.paused);
}

function roll() {
  if (auto && armed && inView && !held && video.paused && !video.ended) video.play().catch(() => {});
}

video.addEventListener('play', () => {
  started = true;
  showState();
  requestAnimationFrame(following);
});
video.addEventListener('pause', showState);
video.addEventListener('ended', () => {
  held = true;
  showState();
  trace();
});
video.addEventListener('seeked', trace);
video.addEventListener('timeupdate', trace);
video.addEventListener('error', () => {
  film.classList.add('failed');
  $('fail').hidden = false;
});

function playOrPause() {
  if (video.ended) video.currentTime = 0;
  if (video.paused) {
    held = false;
    video.play().catch(() => {});
  } else {
    held = true;
    video.pause();
  }
}
toggle.addEventListener('click', playOrPause);
video.addEventListener('click', playOrPause);

sound.addEventListener('click', () => {
  video.muted = !video.muted;
  sound.textContent = video.muted ? 'Turn on sound' : 'Turn off sound';
});

// A silent film stops off screen and picks up when it comes back; one with sound on keeps playing.
new IntersectionObserver(([entry]) => {
  inView = entry.isIntersecting;
  if (inView) roll();
  else if (video.muted && !video.paused) video.pause();
}, { threshold: 0.5 }).observe(film);

tall.addEventListener('change', () => {
  const playing = !video.paused;
  cut = tall.matches ? CUTS.tall : CUTS.wide;
  useCut(0);
  if (playing) video.play().catch(() => {});
});

useCut(auto ? cut.hook : 0);
showState();

// ---------- the clone card
const clone = $('clone');
const label = clone.querySelector('.node__label');
const toast = $('toast');
let toastTimer, labelTimer;

function notify(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('show');
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3600);
}
function legacyCopy(text) {
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.className = 'sr-only';
  document.body.append(field);
  field.select();
  const ok = document.execCommand('copy');
  field.remove();
  clone.focus({ preventScroll: true });
  return ok;
}
clone.addEventListener('click', async () => {
  const text = clone.dataset.copy;
  let copied = false;
  try {
    await navigator.clipboard.writeText(text);
    copied = true;
  } catch {
    try { copied = legacyCopy(text); } catch {}
  }
  if (!copied) {
    notify('Copy was blocked. Select the command on the card and copy it by hand.');
    return;
  }
  notify('Copied the clone command. Nothing ran.');
  label.textContent = 'Copied';
  clearTimeout(labelTimer);
  labelTimer = setTimeout(() => { label.textContent = 'Or copy the clone command'; }, 1800);
});

// ---------- the load sequence: one moment, and any input ends it
function split(el) {
  for (const node of [...el.childNodes]) {
    if (node.nodeType !== Node.TEXT_NODE) { split(node); continue; }
    const words = document.createDocumentFragment();
    node.textContent.split(/(\s+)/).forEach(part => {
      if (!part) return;
      if (!part.trim()) { words.append(' '); return; }
      const mask = document.createElement('span');
      const word = document.createElement('span');
      mask.className = 'w';
      word.textContent = part;
      mask.append(word);
      words.append(mask);
    });
    node.replaceWith(words);
  }
}

function finishSequence(run) {
  root.classList.remove('seq', 'run');
  armed = true;
  if (run) run();
  roll();
}

// An iris opens from the empty prompt's cursor into the film, as it does in the film itself.
function iris() {
  const spot = cursor.getBoundingClientRect();
  const box = film.getBoundingClientRect();
  const page = hero.getBoundingClientRect();
  const x = spot.left + spot.width / 2;
  const y = spot.top + spot.height / 2;
  const far = Math.max(...[[box.left, box.top], [box.right, box.top], [box.left, box.bottom], [box.right, box.bottom]].map(([cx, cy]) => Math.hypot(cx - x, cy - y)));
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  const ring = document.createElementNS(NS, 'circle');
  svg.setAttribute('class', 'iris');
  svg.setAttribute('aria-hidden', 'true');
  ring.setAttribute('cx', x - page.left);
  ring.setAttribute('cy', y - page.top);
  svg.append(ring);
  hero.append(svg);
  const shape = r => `circle(${r}px at ${x - box.left}px ${y - box.top}px)`;
  film.style.clipPath = shape(0);
  const start = performance.now();
  const length = 760;
  requestAnimationFrame(function step(now) {
    const k = Math.min(1, (now - start) / length);
    const r = far * (0.35 * k ** 3 + 0.65 * (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2));
    film.style.clipPath = shape(r);
    ring.setAttribute('r', r);
    ring.style.opacity = 1 - Math.max(0, (k - 0.6) / 0.4);
    if (k < 1) { requestAnimationFrame(step); return; }
    film.style.removeProperty('clip-path');
    svg.remove();
  });
}

function runSequence() {
  const T = { drop: 220, clack: 460, installed: 540, forgot: 1160, mark: 1880, out: 1960, prompt: 2520, iris: 3000 };
  const EXPO = 'cubic-bezier(.16,1,.3,1)';
  const hook = $('hook');
  const mark = hook.querySelector('mark');
  const bar = document.querySelector('.bar');
  const stage = document.querySelector('.stage');
  split(hook);
  root.classList.add('run');

  // the commands whip in, then go out one by one
  [...rows.children].forEach((row, i) => {
    if (row === prompt) return;
    row.animate([{ transform: `translateX(${i % 2 ? 1100 : -1100}px)` }, { transform: 'none' }], { duration: 1100, easing: EXPO });
    row.animate([{ opacity: 0.6 }, { opacity: 0.16 }], { delay: T.out + ((i * 7) % 12) * 40, duration: 180, fill: 'backwards' });
  });

  // the lime half drops onto the ink half like the clip closing, and everything printed on it lands with it
  document.querySelector('.lime').animate([{ transform: 'translateY(-100%)' }, { transform: 'none' }], {
    delay: T.drop, duration: T.clack - T.drop, easing: 'cubic-bezier(.7,0,.84,0)', fill: 'backwards',
  });
  [bar, stage].forEach(el => {
    el.animate([{ opacity: 0 }, { opacity: 0 }], { duration: T.clack });
    el.animate([{ transform: 'translateY(14px)' }, { transform: 'translateY(-4px)', offset: 0.45 }, { transform: 'none' }], { delay: T.clack, duration: 300 });
  });
  wall.animate([{ transform: 'translateY(20px)' }, { transform: 'none' }], { delay: T.clack, duration: 320, easing: EXPO });

  // the hook, in two beats
  [...hook.querySelectorAll('.w > span')].forEach((word, i) => {
    word.animate([{ transform: 'translateY(118%)' }, { transform: 'none' }], {
      delay: i < 3 ? T.installed + i * 70 : T.forgot + (i - 3) * 80, duration: 460, easing: 'cubic-bezier(.2,1.25,.4,1)', fill: 'backwards',
    });
  });

  // the highlighter brushes on behind "forgot", and the word turns lime as it passes
  mark.animate([{ transform: 'skewX(-10deg) scaleX(0)' }, { transform: 'skewX(-10deg) scaleX(1)' }], {
    pseudoElement: '::before', delay: T.mark, duration: 320, easing: EXPO, fill: 'backwards',
  });
  mark.animate([{ color: '#14170f' }, { color: '#14170f' }], { duration: T.mark + 60 });

  // what is left is an empty prompt
  prompt.animate([{ opacity: 0 }, { opacity: 1 }], { delay: T.prompt, duration: 60, fill: 'backwards' });
  cursor.animate([{ opacity: 1 }, { opacity: 1, offset: 0.5 }, { opacity: 0, offset: 0.5 }, { opacity: 0 }], { delay: T.prompt + 120, duration: 300 });

  let skipped = false;
  const skip = () => {
    skipped = true;
    document.getAnimations().forEach(animation => animation.finish());
  };
  const inputs = ['pointerdown', 'keydown', 'wheel', 'touchmove'];
  inputs.forEach(type => addEventListener(type, skip, { passive: true, capture: true, once: true }));

  root.animate([], { duration: T.iris }).finished.then(() => {
    inputs.forEach(type => removeEventListener(type, skip, { capture: true }));
    finishSequence(!skipped && !stacked.matches ? iris : null);
  });
}

if (root.classList.contains('seq') && scrollY < 40) runSequence();
else finishSequence();
