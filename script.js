/* =========================================================================
   Nikolay Vasilev — personal blog script
   - Nav behaviour (scroll state, mobile menu)
   - Light/dark theme toggle + BG/EN interface language toggle
   - Scroll reveal animations
   - Blog posts loaded straight from the GitHub repo's posts/ folder
     (drop a .md file in there and it shows up here automatically)
   - Tiny built-in Markdown + frontmatter parser (no external dependencies)

   NOTE on language: only the interface (nav, buttons, headings, messages)
   is translated. Blog post titles/excerpts/body always come from the
   Markdown files as written and are never auto-translated.
   ========================================================================= */

const REPO_OWNER = "nikovassi";
const REPO_NAME = "nikovassi.github.io";
const REPO_BRANCH = "main";

// GitHub's unauthenticated API allows 60 requests/hour per visitor IP, so we
// fetch the whole repo file tree in ONE call (not one call per post) and
// cache it in sessionStorage for a few minutes. Individual post content is
// fetched separately but cached by its git blob sha, so it's only ever
// re-downloaded when the file itself actually changes.
const TREE_CACHE_KEY = "nv-tree-cache-v1";
const TREE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

class RateLimitError extends Error {}

async function fetchRepoTree() {
  try {
    const cached = sessionStorage.getItem(TREE_CACHE_KEY);
    if (cached) {
      const { timestamp, tree } = JSON.parse(cached);
      if (Array.isArray(tree) && Date.now() - timestamp < TREE_CACHE_TTL_MS) {
        return tree;
      }
    }
  } catch (e) {
    // sessionStorage unavailable/corrupt — just skip the cache.
  }

  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/git/trees/${REPO_BRANCH}?recursive=1`;
  const res = await fetch(url);

  if (res.status === 403) {
    let isRateLimit = false;
    try {
      const data = await res.json();
      isRateLimit = /rate limit/i.test(data.message || "");
    } catch (e) {
      isRateLimit = true;
    }
    if (isRateLimit) throw new RateLimitError("GitHub API rate limit exceeded");
  }
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);

  const data = await res.json();
  const tree = Array.isArray(data.tree) ? data.tree : [];

  try {
    sessionStorage.setItem(TREE_CACHE_KEY, JSON.stringify({ timestamp: Date.now(), tree }));
  } catch (e) {
    // Storage full/blocked — not critical, just means no caching this time.
  }

  return tree;
}

function filesUnder(tree, prefix) {
  return tree
    .filter((item) => item.type === "blob" && item.path.startsWith(prefix))
    .map((item) => ({
      path: item.path,
      name: item.path.slice(prefix.length),
      sha: item.sha,
      download_url: `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${REPO_BRANCH}/${item.path}`,
    }))
    .filter((f) => f.name && !f.name.includes("/"));
}

// Fetches a file's raw content, cached in sessionStorage by its git blob
// sha — so the same unchanged file is never downloaded twice in a visit,
// and an edited file (new sha) always bypasses the stale cache entry.
async function fetchRawCached(file) {
  const key = `nv-content:${file.path}:${file.sha}`;
  try {
    const cached = sessionStorage.getItem(key);
    if (cached !== null) return cached;
  } catch (e) {
    // ignore
  }
  const res = await fetch(file.download_url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to fetch ${file.path}: ${res.status}`);
  const text = await res.text();
  try {
    sessionStorage.setItem(key, text);
  } catch (e) {
    // ignore storage errors
  }
  return text;
}

/* ---------------- Frontmatter + Markdown ---------------- */
// Expects:
// ---
// title: ...
// date: YYYY-MM-DD
// excerpt: ...
// cover: images/posts/xyz.svg
// ---
// Markdown body...
function parseFrontmatter(raw) {
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(raw);
  if (!match) return { meta: {}, body: raw };

  const meta = {};
  match[1].split("\n").forEach((line) => {
    const idx = line.indexOf(":");
    if (idx === -1) return;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    value = value.replace(/^["']|["']$/g, "");
    meta[key] = value;
  });

  return { meta, body: match[2].trim() };
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function inlineMarkdown(text) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" loading="lazy">');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return out;
}

// Small, dependency-free Markdown → HTML renderer. Supports the subset a
// personal blog post actually needs: headings, paragraphs, bold/italic,
// links, images, lists, blockquotes, code spans/blocks, horizontal rules.
function renderMarkdown(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let html = "";
  let i = 0;
  let inList = null; // "ul" | "ol" | null
  let inCode = false;
  let codeBuffer = [];

  function closeList() {
    if (inList) {
      html += `</${inList}>`;
      inList = null;
    }
  }

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      if (!inCode) {
        inCode = true;
        codeBuffer = [];
      } else {
        inCode = false;
        html += `<pre><code>${escapeHtml(codeBuffer.join("\n"))}</code></pre>`;
      }
      i++;
      continue;
    }
    if (inCode) {
      codeBuffer.push(line);
      i++;
      continue;
    }

    if (/^\s*$/.test(line)) {
      closeList();
      i++;
      continue;
    }

    if (/^###\s+/.test(line)) {
      closeList();
      html += `<h3>${inlineMarkdown(line.replace(/^###\s+/, ""))}</h3>`;
      i++;
      continue;
    }
    if (/^##\s+/.test(line)) {
      closeList();
      html += `<h2>${inlineMarkdown(line.replace(/^##\s+/, ""))}</h2>`;
      i++;
      continue;
    }
    if (/^#\s+/.test(line)) {
      closeList();
      html += `<h2>${inlineMarkdown(line.replace(/^#\s+/, ""))}</h2>`;
      i++;
      continue;
    }

    if (/^---+\s*$/.test(line)) {
      closeList();
      html += "<hr>";
      i++;
      continue;
    }

    if (/^>\s?/.test(line)) {
      closeList();
      const quoteLines = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      html += `<blockquote>${inlineMarkdown(quoteLines.join(" "))}</blockquote>`;
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      if (inList !== "ul") {
        closeList();
        html += "<ul>";
        inList = "ul";
      }
      html += `<li>${inlineMarkdown(line.replace(/^[-*]\s+/, ""))}</li>`;
      i++;
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      if (inList !== "ol") {
        closeList();
        html += "<ol>";
        inList = "ol";
      }
      html += `<li>${inlineMarkdown(line.replace(/^\d+\.\s+/, ""))}</li>`;
      i++;
      continue;
    }

    // Paragraph: collect until blank line / block-level element starts.
    closeList();
    const paraLines = [line];
    i++;
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^(#{1,3}\s+|[-*]\s+|\d+\.\s+|>\s?|```|---+\s*$)/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    html += `<p>${inlineMarkdown(paraLines.join(" "))}</p>`;
  }

  closeList();
  return html;
}

// Locale-aware date formatting. `lang` defaults to whatever the interface
// is currently set to (see currentLang below) — this only affects how a
// post's date is displayed, never its title/excerpt/body.
function formatDate(dateStr, lang) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const useLang = lang || currentLang;
  const monthsBg = [
    "януари", "февруари", "март", "април", "май", "юни",
    "юли", "август", "септември", "октомври", "ноември", "декември",
  ];
  const monthsEn = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const months = useLang === "en" ? monthsEn : monthsBg;
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

/* ---------------- Theme (light/dark) ---------------- */
const THEME_KEY = "nv-theme";

function getPreferredTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch (e) {
    // ignore
  }
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

// The inline <head> script already set data-theme on <html> before first
// paint to avoid a flash of the wrong theme — just read it back here.
let currentTheme = document.documentElement.getAttribute("data-theme");
if (currentTheme !== "light" && currentTheme !== "dark") {
  currentTheme = getPreferredTheme();
  document.documentElement.setAttribute("data-theme", currentTheme);
}

/* ---------------- Language (BG/EN interface) ---------------- */
const LANG_KEY = "nv-lang";

let currentLang = "bg";
try {
  const savedLang = localStorage.getItem(LANG_KEY);
  if (savedLang === "bg" || savedLang === "en") currentLang = savedLang;
} catch (e) {
  // ignore
}

const translations = {
  bg: {
    "nav.home": "Начало",
    "nav.about": "За мен",
    "nav.blog": "Блог",
    "nav.contact": "Контакти",
    "hero.eyebrow": "Добре дошли",
    "hero.subtitle": "Тук пиша за нещата, които ме вълнуват — технологии, кариера и живота между тях. Малко лични бележки, малко наученото по трудния начин.",
    "hero.cta.blog": "Виж блога",
    "hero.cta.about": "За мен",
    "about.eyebrow": "За мен",
    "about.heading": "Няколко думи за мен",
    "about.p1": "[Тук ще добавиш кратко представяне — кой си, с какво се занимаваш и какво те вдъхновява да пишеш. Два-три абзаца са напълно достатъчни.]",
    "about.p2": "[Може да добавиш и с какво точно се занимаваш професионално, какви теми те вълнуват в блога, и какво искаш читателите да намерят тук.]",
    "about.fact1.label": "Живее в",
    "about.fact1.value": "България",
    "about.fact2.label": "Пише за",
    "about.fact2.value": "технологии, кариера, живот",
    "about.fact3.label": "Обича",
    "about.fact3.value": "[твое хоби]",
    "about.fact4.label": "В момента",
    "about.fact4.value": "[с какво се занимаваш]",
    "blog.eyebrow": "Блог",
    "blog.heading": "Последни статии",
    "blog.desc": "Директно от repository-то — качваш нова статия в GitHub и тя се появява тук автоматично.",
    "blog.loading": "Зареждане на статиите…",
    "blog.empty": "Скоро тук ще има статии.",
    "blog.error": "Възникна проблем при зареждане на статиите. Презареди страницата.",
    "blog.readmore": "Прочети →",
    "blog.ratelimit": "GitHub временно ограничи заявките от тази мрежа (лимит за анонимен достъп). Презареди страницата след няколко минути.",
    "contact.eyebrow": "Контакти",
    "contact.heading": "Да се свържем",
    "contact.desc": "Ако искаш да обсъдим нещо от блога или просто да си кажем здравей — пиши ми.",
    "contact.email": "✉️ Имейл",
    "contact.github": "💻 GitHub",
    "contact.linkedin": "💼 LinkedIn",
    "footer.tagline": "Направено с ♥ и хоствано на GitHub Pages.",
    "post.back": "← Обратно към блога",
    "post.loading": "Зареждане на статията…",
    "post.notfound.title": "Статията не е намерена",
    "post.notfound.msg": "Тази статия не съществува или е преместена.",
    "post.noslug.msg": "Липсва избрана статия. Върни се към блога и избери статия от списъка.",
    "post.error.title": "Грешка при зареждане",
    "post.error.msg": "Възникна проблем при зареждане на статията. Презареди страницата.",
    "post.allposts": "← Всички статии",
    "toggle.theme": "Смени темата",
    "toggle.lang": "Смени езика",
  },
  en: {
    "nav.home": "Home",
    "nav.about": "About",
    "nav.blog": "Blog",
    "nav.contact": "Contact",
    "hero.eyebrow": "Welcome",
    "hero.subtitle": "Here I write about the things that interest me — technology, career and the life in between. A few personal notes, a few lessons learned the hard way.",
    "hero.cta.blog": "View the blog",
    "hero.cta.about": "About me",
    "about.eyebrow": "About",
    "about.heading": "A few words about me",
    "about.p1": "[Add a short introduction here — who you are, what you do and what inspires you to write. Two or three paragraphs are plenty.]",
    "about.p2": "[You can also add what you do professionally, which topics you cover on the blog, and what you'd like readers to find here.]",
    "about.fact1.label": "Lives in",
    "about.fact1.value": "Bulgaria",
    "about.fact2.label": "Writes about",
    "about.fact2.value": "technology, career, life",
    "about.fact3.label": "Enjoys",
    "about.fact3.value": "[your hobby]",
    "about.fact4.label": "Currently",
    "about.fact4.value": "[what you're up to]",
    "blog.eyebrow": "Blog",
    "blog.heading": "Latest posts",
    "blog.desc": "Straight from the repository — upload a new post to GitHub and it appears here automatically.",
    "blog.loading": "Loading posts…",
    "blog.empty": "Posts are coming soon.",
    "blog.error": "There was a problem loading the posts. Please reload the page.",
    "blog.readmore": "Read more →",
    "blog.ratelimit": "GitHub has temporarily rate-limited requests from this network (anonymous access limit). Please reload the page in a few minutes.",
    "contact.eyebrow": "Contact",
    "contact.heading": "Let's connect",
    "contact.desc": "If you'd like to discuss something from the blog, or just say hello — get in touch.",
    "contact.email": "✉️ Email",
    "contact.github": "💻 GitHub",
    "contact.linkedin": "💼 LinkedIn",
    "footer.tagline": "Made with ♥ and hosted on GitHub Pages.",
    "post.back": "← Back to blog",
    "post.loading": "Loading the post…",
    "post.notfound.title": "Post not found",
    "post.notfound.msg": "This post doesn't exist or has been moved.",
    "post.noslug.msg": "No post selected. Go back to the blog and choose a post from the list.",
    "post.error.title": "Error loading post",
    "post.error.msg": "There was a problem loading the post. Please reload the page.",
    "post.allposts": "← All posts",
    "toggle.theme": "Toggle theme",
    "toggle.lang": "Switch language",
  },
};

// The hero title mixes translatable UI text with an inline accent span, so
// it's handled as a small HTML snippet rather than plain data-i18n text.
const heroTitleHtml = {
  bg: 'Здравей, аз съм <span class="accent">Николай</span>.',
  en: 'Hi, I’m <span class="accent">Nikolay</span>.',
};

function t(key) {
  return (translations[currentLang] && translations[currentLang][key]) || translations.bg[key] || key;
}

/* ---------------- Header / nav (shared across pages) ---------------- */
const header = document.getElementById("siteHeader");
const navToggle = document.getElementById("navToggle");
const navLinks = document.getElementById("navLinks");
const navLinkEls = document.querySelectorAll(".nav-link");
const themeToggle = document.getElementById("themeToggle");
const langToggle = document.getElementById("langToggle");

if (header) {
  window.addEventListener("scroll", () => {
    header.classList.toggle("scrolled", window.scrollY > 40);
  }, { passive: true });
}

if (navToggle && navLinks) {
  navToggle.addEventListener("click", () => {
    const open = navLinks.classList.toggle("open");
    navToggle.classList.toggle("open", open);
    navToggle.setAttribute("aria-expanded", open ? "true" : "false");
  });
  navLinkEls.forEach((link) => {
    link.addEventListener("click", () => {
      navLinks.classList.remove("open");
      navToggle.classList.remove("open");
    });
  });
}

function applyThemeIcon() {
  if (!themeToggle) return;
  // Icon shown is the mode you'd switch TO, which is the common convention.
  themeToggle.textContent = currentTheme === "light" ? "🌙" : "☀️";
}

if (themeToggle) {
  applyThemeIcon();
  themeToggle.addEventListener("click", () => {
    currentTheme = currentTheme === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", currentTheme);
    try {
      localStorage.setItem(THEME_KEY, currentTheme);
    } catch (e) {
      // ignore
    }
    applyThemeIcon();
  });
}

if (langToggle) {
  langToggle.addEventListener("click", () => {
    currentLang = currentLang === "bg" ? "en" : "bg";
    try {
      localStorage.setItem(LANG_KEY, currentLang);
    } catch (e) {
      // ignore
    }
    applyTranslations();
  });
}

// Applies the current language to every static [data-i18n] element and
// re-renders any already-loaded dynamic content (blog grid / post chrome)
// in the new language, without re-fetching anything from GitHub.
function applyTranslations() {
  document.documentElement.setAttribute("lang", currentLang);

  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    el.textContent = t(key);
  });

  const heroTitle = document.getElementById("heroTitle");
  if (heroTitle) heroTitle.innerHTML = heroTitleHtml[currentLang] || heroTitleHtml.bg;

  if (langToggle) {
    langToggle.textContent = currentLang === "bg" ? "EN" : "BG";
    langToggle.setAttribute("aria-label", t("toggle.lang"));
    langToggle.setAttribute("title", t("toggle.lang"));
  }
  if (themeToggle) {
    themeToggle.setAttribute("aria-label", t("toggle.theme"));
    themeToggle.setAttribute("title", t("toggle.theme"));
  }

  renderBlogGrid();
  renderPostChrome();
}

/* ---------------- Reveal on scroll ---------------- */
const revealEls = document.querySelectorAll(".reveal");
if (revealEls.length) {
  const revealObserver = new IntersectionObserver(
    (entries, obs) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("in-view");
          obs.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.15 }
  );
  revealEls.forEach((el) => revealObserver.observe(el));
}

/* ---------------- Footer year ---------------- */
const yearEl = document.getElementById("year");
if (yearEl) yearEl.textContent = new Date().getFullYear();

/* ---------------- Blog listing (index.html) ---------------- */
// lastBlogState holds whatever was last fetched so the language toggle can
// re-render labels/messages instantly, without hitting the network again.
let lastBlogState = { status: "loading", posts: [] };

function renderBlogGrid() {
  const grid = document.getElementById("blogGrid");
  if (!grid) return;

  const { status, posts } = lastBlogState;

  if (status === "loading") {
    grid.innerHTML = `<p class="empty-msg">${t("blog.loading")}</p>`;
    return;
  }
  if (status === "ratelimit") {
    grid.innerHTML = `<p class="error-msg">${t("blog.ratelimit")}</p>`;
    return;
  }
  if (status === "error") {
    grid.innerHTML = `<p class="error-msg">${t("blog.error")}</p>`;
    return;
  }
  if (status === "empty" || posts.length === 0) {
    grid.innerHTML = `<p class="empty-msg">${t("blog.empty")}</p>`;
    return;
  }

  grid.innerHTML = posts
    .map(
      (p) => `
      <a class="post-card reveal in-view" href="post.html?slug=${encodeURIComponent(p.slug)}">
        <div class="post-cover">
          <img src="${p.cover}" alt="${p.title}" loading="lazy">
        </div>
        <div class="post-body">
          ${p.date ? `<span class="post-date">${formatDate(p.date)}</span>` : ""}
          <h3 class="post-title">${p.title}</h3>
          ${p.excerpt ? `<p class="post-excerpt">${p.excerpt}</p>` : ""}
          <span class="post-readmore">${t("blog.readmore")}</span>
        </div>
      </a>`
    )
    .join("");
}

async function loadBlogGrid() {
  const grid = document.getElementById("blogGrid");
  if (!grid) return;

  lastBlogState = { status: "loading", posts: [] };
  renderBlogGrid();

  try {
    const tree = await fetchRepoTree();
    const files = filesUnder(tree, "posts/").filter((f) => f.name.toLowerCase().endsWith(".md"));

    if (files.length === 0) {
      lastBlogState = { status: "empty", posts: [] };
      renderBlogGrid();
      return;
    }

    const posts = await Promise.all(
      files.map(async (f) => {
        try {
          const raw = await fetchRawCached(f);
          const { meta } = parseFrontmatter(raw);
          const slug = f.name.replace(/\.md$/i, "");
          return {
            slug,
            title: meta.title || slug,
            date: meta.date || "",
            excerpt: meta.excerpt || "",
            cover: meta.cover || "images/post-cover-placeholder.svg",
          };
        } catch (e) {
          console.error("Failed to load post", f.path, e);
          return null;
        }
      })
    );

    const validPosts = posts
      .filter(Boolean)
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""));

    lastBlogState = { status: validPosts.length === 0 ? "empty" : "ok", posts: validPosts };
    renderBlogGrid();
  } catch (err) {
    console.error(err);
    lastBlogState = { status: err instanceof RateLimitError ? "ratelimit" : "error", posts: [] };
    renderBlogGrid();
  }
}

/* ---------------- Single post (post.html) ---------------- */
// lastPostState mirrors lastBlogState's purpose: cache what's already been
// fetched so the language toggle only re-renders chrome (date format,
// loading/error labels) — post title/body are never re-translated.
let lastPostState = { status: "loading", meta: null };

function renderPostChrome() {
  const titleEl = document.getElementById("postTitle");
  const dateEl = document.getElementById("postDate");
  const contentEl = document.getElementById("postContent");
  if (!contentEl || !titleEl) return;

  const { status, meta } = lastPostState;

  if (status === "noslug") {
    titleEl.textContent = t("post.notfound.title");
    contentEl.innerHTML = `<p class="empty-msg">${t("post.noslug.msg")}</p>`;
    return;
  }
  if (status === "loading") {
    contentEl.innerHTML = `<p class="empty-msg">${t("post.loading")}</p>`;
    return;
  }
  if (status === "notfound") {
    titleEl.textContent = t("post.notfound.title");
    contentEl.innerHTML = `<p class="empty-msg">${t("post.notfound.msg")}</p>`;
    return;
  }
  if (status === "error") {
    titleEl.textContent = t("post.error.title");
    contentEl.innerHTML = `<p class="error-msg">${t("post.error.msg")}</p>`;
    return;
  }
  if (status === "ok" && meta) {
    // Title & body are post content — always shown exactly as written in
    // the Markdown file, regardless of the interface language.
    titleEl.textContent = meta.title;
    if (dateEl && meta.date) dateEl.textContent = formatDate(meta.date);
    contentEl.innerHTML = meta.contentHtml;
  }
}

async function loadSinglePost() {
  const contentEl = document.getElementById("postContent");
  if (!contentEl) return;

  const coverWrap = document.getElementById("articleCover");
  const coverImg = document.getElementById("postCoverImg");
  const pageTitle = document.getElementById("pageTitle");

  const params = new URLSearchParams(window.location.search);
  const slug = params.get("slug");

  if (!slug) {
    lastPostState = { status: "noslug", meta: null };
    renderPostChrome();
    return;
  }

  lastPostState = { status: "loading", meta: null };
  renderPostChrome();

  try {
    const url = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${REPO_BRANCH}/posts/${slug}.md`;
    const res = await fetch(url, { cache: "no-store" });
    if (res.status === 404) {
      lastPostState = { status: "notfound", meta: null };
      renderPostChrome();
      return;
    }
    if (!res.ok) throw new Error(`GitHub ${res.status}`);

    const raw = await res.text();
    const { meta, body } = parseFrontmatter(raw);

    const title = meta.title || slug;
    if (pageTitle) pageTitle.textContent = `${title} — Nikolay Vasilev`;

    if (meta.cover && coverWrap && coverImg) {
      coverImg.src = meta.cover;
      coverImg.alt = title;
      coverWrap.hidden = false;
    }

    lastPostState = {
      status: "ok",
      meta: { title, date: meta.date || "", contentHtml: renderMarkdown(body) },
    };
    renderPostChrome();
  } catch (err) {
    console.error(err);
    lastPostState = { status: "error", meta: null };
    renderPostChrome();
  }
}

applyTranslations();
loadBlogGrid();
loadSinglePost();
