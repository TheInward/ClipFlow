"""Resolve a public Douyin video using a fresh browser session."""
import json
import sys
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright


def resolve(url):
    if urlparse(url).hostname not in {"v.douyin.com", "www.douyin.com", "douyin.com", "www.iesdouyin.com"}:
        raise ValueError("只支持抖音分享链接")
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
        try:
            page = browser.new_page()
            responses = []
            page.on("response", lambda r: responses.append(r) if
                    urlparse(r.url).hostname == "www.douyin.com" and
                    "/aweme/v1/web/aweme/detail/" in r.url and r.status == 200 else None)
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
            detail = None
            for _ in range(30):
                page.wait_for_timeout(500)
                while responses:
                    response = responses.pop(0)
                    try:
                        data = response.json()
                        if data.get("status_code") == 0 and data.get("aweme_detail"):
                            detail = data["aweme_detail"]
                            break
                    except Exception:
                        continue
                if detail:
                    break
            if not detail:
                raise ValueError("暂时无法读取抖音作品，请确认作品公开可访问后重试")
            video = detail.get("video") or {}
            rates = [r for r in video.get("bit_rate", [])
                     if r.get("bit_rate", 0) > 0 and (r.get("play_addr") or {}).get("url_list")]
            rates.sort(key=lambda r: r["bit_rate"])
            if not rates:
                raise ValueError("该作品没有可下载的视频码率，暂不支持图集")
            index = (len(rates) - 1) // 2
            chosen = rates[index]
            return {"url": chosen["play_addr"]["url_list"][0],
                    "id": str(detail.get("aweme_id", "video")),
                    "bitrate": chosen["bit_rate"], "variants": len(rates), "rank": index + 1}
        finally:
            browser.close()


if __name__ == "__main__":
    try:
        print(json.dumps(resolve(sys.argv[1]), ensure_ascii=False))
    except Exception:
        print(json.dumps({"error": "抖音解析失败，请确认作品公开可访问后稍后重试"}, ensure_ascii=False))
        sys.exit(1)
