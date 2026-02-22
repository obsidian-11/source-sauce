import requests
from readability import Document
from bs4 import BeautifulSoup
from urllib.parse import urlparse, urlunparse

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/122.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    "Referer": "https://www.google.com/",
}

def clean_url(url: str) -> str:
    """Fix malformed URLs like trailing slash after query string."""
    parsed = urlparse(url)
    query = parsed.query.rstrip("/")
    return urlunparse(parsed._replace(query=query))

def fetch_page_text(url: str) -> str:
    try:
        url = clean_url(url)
        resp = requests.get(url, headers=HEADERS, timeout=10)
        if resp.status_code != 200:
            print(f"[Fetcher] {url} returned status {resp.status_code}")
            return ""

        doc = Document(resp.text)
        html_content = doc.summary()

        soup = BeautifulSoup(html_content, "html.parser")
        text = soup.get_text(separator="\n")
        text = "\n".join(line.strip() for line in text.splitlines() if line.strip())

        if len(text.split()) < 50:
            print(f"[Fetcher] {url} returned too little text ({len(text.split())} words)")
            return ""

        return text

    except Exception as e:
        print(f"[Fetcher] Error fetching {url}: {e}")
        return ""