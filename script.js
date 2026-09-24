/* =========================================================================
   Nikolay Vasilev — personal blog script
   - Nav behaviour (scroll state, mobile menu)
   - Scroll reveal animations
   - Blog posts loaded straight from the GitHub repo's posts/ folder
     (drop a .md file in there and it shows up here automatically)
   - Tiny built-in Markdown + frontmatter parser (no external dependencies)
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

const RATE_LIMIT_MSG =
  '<p class="error-msg">GitHub временно ограничи заявките от тази мрежа (лимит за анонимен достъп). Презареди страницата след няколко минути.</p>';

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

function formatDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const months = [
    "януари", "февруари", "март", "април", "май", "юни",
    "юли", "август", "септември", "октомври", "ноември", "декември",
  ];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

/* ---------------- Header / nav (shared across pages) ---------------- */
const header = document.getElementById("siteHeader");
const navToggle = document.getElementById("navToggle");
const navLinks = document.getElementById("navLinks");
const navLinkEls = document.querySelectorAll(".nav-link");

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
async function loadBlogGrid() {
  const grid = document.getElementById("blogGrid");
  if (!grid) return;

  try {
    const tree = await fetchRepoTree();
    const files = filesUnder(tree, "posts/").filter((f) => f.name.toLowerCase().endsWith(".md"));

    if (files.length === 0) {
      grid.innerHTML = '<p class="empty-msg">Скоро тук ще има статии.</p>';
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

    if (validPosts.length === 0) {
      grid.innerHTML = '<p class="empty-msg">Скоро тук ще има статии.</p>';
      return;
    }

    grid.innerHTML = validPosts
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
            <span class="post-readmore">Прочети →</span>
          </div>
        </a>`
      )
      .join("");
  } catch (err) {
    console.error(err);
    grid.innerHTML =
      err instanceof RateLimitError
        ? RATE_LIMIT_MSG
        : '<p class="error-msg">Възникна проблем при зареждане на статиите. Презареди страницата.</p>';
  }
}

/* ---------------- Single post (post.html) ---------------- */
async function loadSinglePost() {
  const contentEl = document.getElementById("postContent");
  if (!contentEl) return;

  const titleEl = document.getElementById("postTitle");
  const dateEl = document.getElementById("postDate");
  const coverWrap = document.getElementById("articleCover");
  const coverImg = document.getElementById("postCoverImg");
  const pageTitle = document.getElementById("pageTitle");

  const params = new URLSearchParams(window.location.search);
  const slug = params.get("slug");

  if (!slug) {
    titleEl.textContent = "Статията не е намерена";
    contentEl.innerHTML = '<p class="empty-msg">Липсва избрана статия. Върни се към блога и избери статия от списъка.</p>';
    return;
  }

  try {
    const url = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${REPO_BRANCH}/posts/${slug}.md`;
    const res = await fetch(url, { cache: "no-store" });
    if (res.status === 404) {
      titleEl.textContent = "Статията не е намерена";
      contentEl.innerHTML = '<p class="empty-msg">Тази статия не съществува или е преместена.</p>';
      return;
    }
    if (!res.ok) throw new Error(`GitHub ${res.status}`);

    const raw = await res.text();
    const { meta, body } = parseFrontmatter(raw);

    const title = meta.title || slug;
    titleEl.textContent = title;
    if (pageTitle) pageTitle.textContent = `${title} — Nikolay Vasilev`;
    if (dateEl && meta.date) dateEl.textContent = formatDate(meta.date);

    if (meta.cover && coverWrap && coverImg) {
      coverImg.src = meta.cover;
      coverImg.alt = title;
      coverWrap.hidden = false;
    }

    contentEl.innerHTML = renderMarkdown(body);
  } catch (err) {
    console.error(err);
    titleEl.textContent = "Грешка при зареждане";
    contentEl.innerHTML =
      '<p class="error-msg">Възникна проблем при зареждане на статията. Презареди страницата.</p>';
  }
}

loadBlogGrid();
loadSinglePost();
