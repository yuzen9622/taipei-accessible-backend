#!/usr/bin/env python3
"""Scrape the Taichung Social Affairs Bureau "身心障礙" (Persons with Disabilities)
subtree into per-article Markdown files for use as a RAG knowledge base.

One-off data-collection tool. It does not touch the backend runtime (`src/`),
package.json, or the TS build. Scope is a strict allowlist derived from four
seeded entry points under node 13792 — the site-wide mega-menu is never crawled.

Usage:
    python scripts/rag/scrape_taichung_disability.py [--out DIR]

Deps: requests, beautifulsoup4, html2text (install in an isolated venv).
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sys
import time
from collections import deque
from urllib.parse import urljoin, urlparse, urlencode, parse_qsl, urlsplit

import ssl

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.ssl_ import create_urllib3_context
from bs4 import BeautifulSoup
import html2text


HOST = "www.society.taichung.gov.tw"
BASE = f"https://{HOST}"

# --- Scope allowlist (see plan §Crawl algorithm) -------------------------------
# The three Lpsimplelist node ids that are paginated for post links.
SEED_LISTS = {
    "13798": "身心障礙者福利",
    "13801": "ICF鑑定新制",
    "2038480": "違反權保法公告",
}
# The single intro post seeded directly (full path form).
SEED_POST_URLS = {
    "736703": (
        "簡介",
        f"{BASE}/13710/13735/13792/13795/736703/post",
    ),
}

# Defensive caps.
MAX_LIST_PAGES = 50   # per list node
MAX_FETCHES = 400
PAGE_SIZE = 30

# Politeness / resilience.
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
TIMEOUT = 30
MAX_RETRIES = 5
BACKOFF = 2.5
SLEEP_BETWEEN = 1.0

# Content-container selector priority list.
CONTENT_SELECTORS = [
    "main",
    "[role=main]",
    "#center",
    "#maincontent",
    ".area-editor",
    ".cbody",
    ".data-list",
    ".page-content",
]
# Elements to strip before markdown conversion (id/class match).
STRIP_RE = re.compile(r"menu|nav|breadcrumb|sidebar|footer|header|share", re.I)

POST_HREF_RE = re.compile(r"/(\d+)/post/?$")
DATE_RE = re.compile(r"(\d{4})[-/](\d{1,2})[-/](\d{1,2})")
PAGE_TOTAL_RE = re.compile(r"第\s*\d+\s*/\s*(\d+)\s*頁")
RECORD_TOTAL_RE = re.compile(r"共\s*(\d+)\s*筆")


class RelaxedTLSAdapter(HTTPAdapter):
    """The Taichung gov cert is missing the Subject Key Identifier extension,
    which Python 3.12+ rejects under the default strict X.509 policy. Keep full
    chain verification but drop only the RFC-5280 strict flag."""

    def init_poolmanager(self, *args, **kwargs):
        ctx = create_urllib3_context()
        ctx.verify_flags &= ~ssl.VERIFY_X509_STRICT
        kwargs["ssl_context"] = ctx
        return super().init_poolmanager(*args, **kwargs)


session = requests.Session()
session.headers.update({"User-Agent": USER_AGENT})
session.mount("https://", RelaxedTLSAdapter())


def log(msg: str) -> None:
    print(msg, flush=True)


def fetch(url: str) -> str | None:
    """GET a URL as UTF-8 text with retries. Returns None on persistent failure."""
    last_err = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = session.get(url, timeout=TIMEOUT)
            if resp.status_code == 404:
                log(f"  404 {url}")
                return None
            if resp.status_code >= 500:
                raise requests.HTTPError(f"{resp.status_code}")
            resp.raise_for_status()
            resp.encoding = "utf-8"
            time.sleep(SLEEP_BETWEEN)
            return resp.text
        except Exception as e:  # noqa: BLE001 - broad by design for a scraper
            last_err = e
            if attempt < MAX_RETRIES:
                time.sleep(BACKOFF * attempt)
    log(f"  FAILED {url} :: {last_err}")
    return None


def same_host(url: str) -> bool:
    return urlparse(url).netloc == HOST


def normalize(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}{parts.path.rstrip('/')}"


def pick_content(soup: BeautifulSoup):
    """Return the main content element using the priority selector list, with a
    fallback that anchors on the 發布日期 label."""
    for sel in CONTENT_SELECTORS:
        el = soup.select_one(sel)
        if el is not None:
            return el, sel
    # Fallback: find the node holding 發布日期 and climb to a block ancestor.
    label = soup.find(string=re.compile("發布日期"))
    if label is not None:
        node = label.parent
        for _ in range(6):
            if node is None:
                break
            if node.name in ("article", "section", "div", "main"):
                return node, "fallback:發布日期"
            node = node.parent
    return soup.body or soup, "fallback:body"


def clean_container(el) -> None:
    for tag in el.find_all(["script", "style", "nav", "header", "footer"]):
        if not getattr(tag, "decomposed", False):
            tag.decompose()
    for tag in el.find_all(True):
        # Decomposing an ancestor detaches descendants still in this list.
        if getattr(tag, "decomposed", False) or tag.attrs is None:
            continue
        cls = tag.get("class", []) or []
        ident = " ".join(filter(None, [tag.get("id", "") or "", " ".join(cls)]))
        if ident and STRIP_RE.search(ident):
            tag.decompose()


# Site navigation chrome that html2text leaves in the body of every article.
BOILERPLATE_LINE_RE = re.compile(
    r"(現在位置|友善列印|回上一頁|當script無法執行|您的瀏覽器不支援JavaScript)"
)


def to_markdown(el) -> str:
    h = html2text.HTML2Text()
    h.body_width = 0          # no hard wrapping
    h.ignore_images = True
    h.ignore_emphasis = False
    h.protect_links = True
    md = h.handle(str(el))
    # Drop navigation-chrome lines (breadcrumb + print/back toolbar) and the
    # ":::" div fence markers html2text emits for them.
    kept = []
    for line in md.splitlines():
        stripped = line.strip()
        if stripped.startswith(":::") or BOILERPLATE_LINE_RE.search(stripped):
            continue
        kept.append(line)
    md = "\n".join(kept)
    # Collapse 3+ blank lines.
    return re.sub(r"\n{3,}", "\n\n", md).strip()


def extract_dates(text: str) -> tuple[str, str]:
    """Return (publish_date, last_modified) as YYYY-MM-DD strings when present."""
    pub = mod = ""
    m_pub = re.search(r"發布日期[：: ]*" + DATE_RE.pattern, text)
    if m_pub:
        pub = f"{int(m_pub.group(1)):04d}-{int(m_pub.group(2)):02d}-{int(m_pub.group(3)):02d}"
    m_mod = re.search(r"(最後異動|異動日期)[：: ]*" + DATE_RE.pattern, text)
    if m_mod:
        mod = f"{int(m_mod.group(2)):04d}-{int(m_mod.group(3)):02d}-{int(m_mod.group(4)):02d}"
    return pub, mod


def slugify(title: str) -> str:
    s = re.sub(r'[/\\:*?"<>|\s]+', "-", title).strip("-")
    s = re.sub(r"-{2,}", "-", s)
    return s[:80] or "post"


ATTACH_RE = re.compile(r"\.(pdf|docx?|xlsx?|odt|ods|csv|zip)(\?|$)", re.I)


def extract_attachments(content_el) -> list[str]:
    urls = []
    for a in content_el.find_all("a", href=True):
        href = a["href"].strip()
        if ATTACH_RE.search(href) or "download" in href.lower():
            urls.append(urljoin(BASE, href))
    # Dedupe preserving order.
    seen = set()
    out = []
    for u in urls:
        if u not in seen:
            seen.add(u)
            out.append(u)
    return out


def yaml_escape(s: str) -> str:
    return s.replace('"', '\\"')


CATEGORY_SLUG = {
    "簡介": "00-intro",
    "身心障礙者福利": "01-welfare",
    "ICF鑑定新制": "02-icf",
    "違反權保法公告": "03-violations",
}


def find_existing(out_dir: str, category: str, post_id: str) -> str | None:
    cat_slug = CATEGORY_SLUG.get(category, "99-other")
    matches = glob.glob(os.path.join(out_dir, cat_slug, f"{post_id}-*.md"))
    return matches[0] if matches else None


def write_post_md(out_dir: str, category: str, post_id: str, url: str, html: str):
    """Parse a post's HTML, write its Markdown file, and return the manifest
    entry dict (or None if nothing was written)."""
    soup = BeautifulSoup(html, "html.parser")

    content_el, matched_sel = pick_content(soup)
    page_text = content_el.get_text(" ", strip=True)
    pub, mod = extract_dates(soup.get_text(" ", strip=True))
    attachments = extract_attachments(content_el)

    # Article title: first non-empty heading INSIDE the content container.
    title = ""
    for h in content_el.find_all(["h1", "h2", "h3"]):
        t = h.get_text(strip=True)
        if t:
            title = t
            break
    if not title:
        # Fall back to the <title> tag; format is
        # "臺中市政府社會局全球資訊網-<category>-<article title>" → take last segment.
        tt = soup.find("title")
        raw = tt.get_text(strip=True) if tt else ""
        segs = [s for s in re.split(r"[-｜|]", raw) if s.strip()]
        title = (segs[-1].strip() if segs else "") or f"post-{post_id}"

    clean_container(content_el)
    body_md = to_markdown(content_el)

    note = ""
    if not body_md or len(page_text) < 20:
        note = "\n\n(無內文)"

    cat_slug = CATEGORY_SLUG.get(category, "99-other")

    cat_dir = os.path.join(out_dir, cat_slug)
    os.makedirs(cat_dir, exist_ok=True)
    fname = f"{post_id}-{slugify(title)}.md"
    fpath = os.path.join(cat_dir, fname)

    attach_yaml = "\n".join(f"  - {u}" for u in attachments) or "  []"
    frontmatter = (
        "---\n"
        f'title: "{yaml_escape(title)}"\n'
        f"url: {url}\n"
        f'category: "{category}"\n'
        f"post_id: {post_id}\n"
        f'publish_date: "{pub}"\n'
        f'last_modified: "{mod}"\n'
        f"attachments:\n{attach_yaml}\n"
        "scraped_from: society.taichung.gov.tw\n"
        "---\n\n"
    )
    with open(fpath, "w", encoding="utf-8") as f:
        f.write(frontmatter)
        f.write(f"# {title}\n\n")
        f.write(body_md + note + "\n")

    log(f"  saved [{category}] {post_id} {title}  (sel={matched_sel}, {len(body_md)} chars)")
    return {
        "post_id": post_id,
        "title": title,
        "category": category,
        "url": url,
        "publish_date": pub,
        "last_modified": mod,
        "attachments": attachments,
        "file": os.path.relpath(fpath, out_dir),
        "selector": matched_sel,
        "empty": bool(note),
    }


def list_page_url(node_id: str, page: int) -> str:
    q = urlencode({"PageSize": PAGE_SIZE, "Page": page, "type": ""})
    return f"{BASE}/{node_id}/Lpsimplelist?{q}"


def harvest_list(node_id: str) -> list[str]:
    """Paginate a Lpsimplelist node; return ordered unique post ids found in its
    content container."""
    post_ids: list[str] = []
    seen = set()
    # Fetch page 1 to learn total pages.
    html = fetch(list_page_url(node_id, 1))
    if html is None:
        return post_ids
    total_pages = 1
    m = PAGE_TOTAL_RE.search(BeautifulSoup(html, "html.parser").get_text(" "))
    if m:
        total_pages = min(int(m.group(1)), MAX_LIST_PAGES)
    rec = RECORD_TOTAL_RE.search(BeautifulSoup(html, "html.parser").get_text(" "))
    total_records = rec.group(1) if rec else "?"
    log(f"list {node_id} ({SEED_LISTS.get(node_id)}): {total_records} records, {total_pages} pages")

    for page in range(1, total_pages + 1):
        page_html = html if page == 1 else fetch(list_page_url(node_id, page))
        if page_html is None:
            log(f"  !! list {node_id} page {page}/{total_pages} FAILED — harvest incomplete")
            continue
        soup = BeautifulSoup(page_html, "html.parser")
        content_el, _ = pick_content(soup)
        for a in content_el.find_all("a", href=True):
            hm = POST_HREF_RE.search(a["href"])
            if hm:
                pid = hm.group(1)
                if pid not in seen:
                    seen.add(pid)
                    post_ids.append(pid)
    log(f"  -> {len(post_ids)} unique posts harvested")
    return post_ids


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--out",
        default=os.path.join(
            os.path.dirname(__file__), "..", "..",
            "data", "rag", "taichung-disability",
        ),
    )
    ap.add_argument(
        "--fresh", action="store_true",
        help="Ignore already-downloaded files and re-fetch everything.",
    )
    args = ap.parse_args()
    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)

    manifest_path = os.path.join(out_dir, "manifest.jsonl")
    failures_path = os.path.join(out_dir, "_failures.log")

    # Resume support: reuse manifest entries for posts already downloaded so a
    # re-run only fetches the gaps left by transient throttling.
    prev: dict[str, dict] = {}
    if not args.fresh and os.path.exists(manifest_path):
        for line in open(manifest_path, encoding="utf-8"):
            line = line.strip()
            if line:
                try:
                    e = json.loads(line)
                    prev[str(e["post_id"])] = e
                except (json.JSONDecodeError, KeyError):
                    pass

    seen_post_ids: set[str] = set()
    entries: list[dict] = []
    fetches = 0
    saved = 0
    reused = 0
    failures: list[str] = []

    def handle_post(pid: str, category: str, url: str) -> None:
        nonlocal fetches, saved, reused
        if pid in seen_post_ids:
            return
        # Resume: keep the existing file + manifest entry, skip the network.
        if not args.fresh and pid in prev and find_existing(out_dir, category, pid):
            entries.append(prev[pid])
            seen_post_ids.add(pid)
            reused += 1
            return
        if fetches >= MAX_FETCHES:
            log("MAX_FETCHES reached; stopping.")
            return
        if not same_host(url):
            return
        fetches += 1
        html = fetch(url)
        if html is None:
            failures.append(url)
            return
        entry = write_post_md(out_dir, category, pid, normalize(url), html)
        if entry:
            entries.append(entry)
            saved += 1
            seen_post_ids.add(pid)

    # 1) Seeded intro post(s).
    for pid, (category, url) in SEED_POST_URLS.items():
        handle_post(pid, category, url)

    # 2) Each seeded list: harvest post ids, then fetch each post.
    for node_id, category in SEED_LISTS.items():
        for pid in harvest_list(node_id):
            handle_post(pid, category, f"{BASE}/{pid}/post")

    # Rewrite the manifest fresh from all collected entries (reused + new).
    with open(manifest_path, "w", encoding="utf-8") as manifest_fp:
        for e in entries:
            manifest_fp.write(json.dumps(e, ensure_ascii=False) + "\n")

    with open(failures_path, "w", encoding="utf-8") as f:
        for u in failures:
            f.write(u + "\n")

    log("")
    log(f"DONE. new={saved} reused={reused} total={len(entries)} "
        f"fetched={fetches} failed={len(failures)}")
    log(f"output: {out_dir}")
    log(f"manifest: {manifest_path}")
    if failures:
        log(f"failures logged: {failures_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
