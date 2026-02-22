# main.py
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from services.fetcher import fetch_page_text
from services.ai_detector import detect_ai
from services.credibility import score_credibility
from utils.mongo import get_collection
from concurrent.futures import ThreadPoolExecutor
import traceback

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

class URLList(BaseModel):
    urls: list[str]

@app.post("/analyze_urls")
def analyze_urls(payload: URLList):
    urls = payload.urls
    print(f"[analyze_urls] Received {len(urls)} URLs")
    collection = get_collection()

    def process_url(url):
        try:
            print(f"[process_url] Starting: {url}")

            existing = collection.find_one({"url": url})
            if existing:
                print(f"[process_url] Cache hit: {url}")
                existing["_id"] = str(existing["_id"])
                return existing

            text = fetch_page_text(url)
            if not text:
                print(f"[process_url] Failed to fetch: {url}")
                return {"url": url, "error": "Failed to fetch content"}

            print(f"[process_url] Scoring {len(text)} chars...")
            ai_prob = detect_ai(text)
            print(f"[process_url] ai_prob={ai_prob}")

            content_type = "blog"
            if ".pdf" in url:
                content_type = "pdf"
            elif any(domain in url for domain in ["news", "nytimes", "guardian"]):
                content_type = "news"

            credibility = score_credibility(ai_prob, url, content_type, text)

            record = {
                "url": url,
                "ai_probability": ai_prob,
                "credibility_score": credibility["credibility_score"],
                "reasoning": credibility["reasoning"],
                "signals": credibility["signals"],
                "content_type": content_type,
            }

            inserted = collection.insert_one(record)
            record["_id"] = str(inserted.inserted_id)
            print(f"[process_url] Done: {url} → ai_prob={ai_prob}, credibility={credibility}")
            return record

        except Exception as e:
            print(f"[process_url] EXCEPTION for {url}: {e}")
            print(traceback.format_exc())
            return {"url": url, "error": str(e)}

    with ThreadPoolExecutor(max_workers=3) as executor:
        results = list(executor.map(process_url, urls))

    return results

@app.delete("/flush_cache")
def flush_cache():
    collection = get_collection()
    result = collection.delete_many({})
    return {"deleted": result.deleted_count}
