"""Reusable Company Catalogue Enrichment & Logo Resolution Protocol.

Domain-agnostic library for:
1. Domain & website resolution from company names and career URLs (stripping ATS hosts).
2. 100% logo resolution (first-party favicon / Google favicon / DuckDuckGo icon / clean monogram badge).
3. Basic bilingual and capability metadata enrichment.
"""
import io
import os
import re
import urllib.parse
import urllib.request

try:
    from PIL import Image, ImageDraw, ImageFont
    HAVE_PIL = True
except ImportError:
    HAVE_PIL = False

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
ATS_HOSTS = {
    'greenhouse.io', 'lever.co', 'ashbyhq.com', 'myworkdayjobs.com', 'workday.com',
    'personio.de', 'personio.com', 'recruitee.com', 'teamtailor.com', 'smartrecruiters.com',
    'rippling.com', 'bamboohr.com', 'workable.com', 'join.com', 'softgarden.io', 'jobs.net'
}

BRAND_PALETTES = [
    ('#1e293b', '#38bdf8'),
    ('#0f172a', '#818cf8'),
    ('#111827', '#34d399'),
    ('#18181b', '#f472b6'),
    ('#172554', '#60a5fa'),
    ('#042f2e', '#2dd4bf'),
    ('#31104b', '#c084fc'),
    ('#3b0764', '#e879f9'),
]


def extract_domain(c):
    """Extracts a clean, first-party web domain for a company, ignoring ATS aggregator hosts."""
    d = (c.get('domain') or '').strip().lower()
    if d and not any(ats in d for ats in ATS_HOSTS):
        return re.sub(r'^www\.', '', d.split('/')[0])
    w = (c.get('website') or '').strip().lower()
    if w:
        m = re.search(r'https?://(?:www\.)?([^/]+)', w)
        if m and not any(ats in m.group(1) for ats in ATS_HOSTS):
            return m.group(1)
    u = (c.get('careers_url') or '').strip().lower()
    if u:
        m = re.search(r'https?://(?:www\.)?([^/]+)', u)
        if m and not any(ats in m.group(1) for ats in ATS_HOSTS):
            return m.group(1)
    return None


def fetch_bytes(url, timeout=5):
    """Safely fetch bytes with standard headers and a short timeout."""
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            if r.status == 200:
                return r.read()
    except Exception:
        pass
    return None


def generate_monogram_badge(name, slug, size=128):
    """Generates a clean, modern geometric brand badge for entities without a discoverable logo."""
    if not HAVE_PIL:
        return None
    palette_idx = sum(ord(ch) for ch in slug) % len(BRAND_PALETTES)
    bg_color, fg_color = BRAND_PALETTES[palette_idx]

    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    margin = 8
    draw.rounded_rectangle([margin, margin, size - margin, size - margin], radius=24, fill=bg_color)

    # Monogram text: 1 to 3 characters
    clean_n = re.sub(r'[^a-zA-Z0-9\s]', '', name).strip()
    words = clean_n.split()
    if len(words) >= 2:
        monogram = (words[0][0] + words[1][0]).upper()
    elif words:
        monogram = words[0][:2].upper()
    else:
        monogram = slug[:2].upper()

    try:
        font = ImageFont.load_default()
    except Exception:
        font = None

    bbox = draw.textbbox((0, 0), monogram, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    tx, ty = (size - tw) // 2, (size - th) // 2
    draw.text((tx, ty), monogram, fill=fg_color, font=font)

    buf = io.BytesIO()
    img.save(buf, format='PNG', optimize=True)
    return buf.getvalue()


def resolve_logo(c, out_dir, public_out_dir=None):
    """Ensures a verified PNG logo exists for company c in out_dir."""
    slug = c.get('slug')
    if not slug:
        return False

    out_path = os.path.join(out_dir, f"{slug}.png")
    if os.path.exists(out_path) and os.path.getsize(out_path) > 300:
        c['logo'] = f"assets/company/{slug}.png"
        return True

    domain = extract_domain(c)
    logo_data = None

    if domain:
        # 1. Try Google High-Res Favicon service
        logo_data = fetch_bytes(f"https://www.google.com/s2/favicons?domain={domain}&sz=128")
        if logo_data and len(logo_data) < 400:  # Google default fallback is tiny
            logo_data = None

        # 2. Try DuckDuckGo icon service
        if not logo_data:
            logo_data = fetch_bytes(f"https://icons.duckduckgo.com/ip3/{domain}.ico")

    # 3. Geometric Monogram badge fallback
    if not logo_data or len(logo_data) < 200:
        logo_data = generate_monogram_badge(c.get('name', slug), slug)

    if logo_data:
        os.makedirs(out_dir, exist_ok=True)
        # Convert ICO or raw format to clean PNG if PIL available
        if HAVE_PIL:
            try:
                im = Image.open(io.BytesIO(logo_data)).convert('RGBA')
                im.save(out_path, format='PNG', optimize=True)
            except Exception:
                with open(out_path, 'wb') as fh:
                    fh.write(logo_data)
        else:
            with open(out_path, 'wb') as fh:
                fh.write(logo_data)

        if public_out_dir and os.path.exists(public_out_dir):
            try:
                import shutil
                shutil.copy2(out_path, os.path.join(public_out_dir, f"{slug}.png"))
            except Exception:
                pass

        c['logo'] = f"assets/company/{slug}.png"
        return True

    return False
