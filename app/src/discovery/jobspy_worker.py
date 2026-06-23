"""One-request JSON bridge around the MIT-licensed python-jobspy package."""

import json
import math
import sys
from datetime import date, datetime


def clean(value):
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(k): clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [clean(v) for v in value]
    try:
        if hasattr(value, "item"):
            return clean(value.item())
    except Exception:
        pass
    return value


def main():
    request = json.loads(sys.stdin.readline() or "{}")
    from jobspy import scrape_jobs

    source = str(request.get("source") or "indeed").lower()
    wanted = max(1, min(100, int(request.get("limit") or 25)))
    country = str(request.get("country") or "Canada")
    # `location` is ALWAYS a geography. LinkedIn has no country param, so the geography
    # must carry it — when the planner sends an empty location, fall back to the country
    # so a search is never borderless. Work-mode ("remote") is a SEPARATE boolean below,
    # never folded into the location string.
    location = str(request.get("location") or "").strip() or country
    kwargs = {
        "site_name": [source],
        "search_term": str(request.get("keyword") or ""),
        "location": location,
        "results_wanted": wanted,
        "hours_old": max(1, min(720, int(request.get("hours_old") or 72))),
        "verbose": 0,
    }
    if source in ("indeed", "glassdoor"):
        kwargs["country_indeed"] = country
    # Google Jobs is driven by ONE natural-language query string (google_search_term);
    # JobSpy IGNORES the plain `search_term` for the google site, so without this the Google
    # scraper returns an empty frame. Compose the term + geography + a freshness hint into the
    # kind of phrase a person would type into Google ("software engineer jobs near Toronto, ON
    # since yesterday"). hours_old above already clamps the freshness window.
    if source == "google":
        term = str(request.get("keyword") or "").strip()
        hrs = max(1, min(720, int(request.get("hours_old") or 72)))
        since = "since yesterday" if hrs <= 24 else ("in the last week" if hrs <= 168 else "in the last month")
        parts = [p for p in [term, "jobs", ("near " + location) if location else "", since] if p]
        kwargs["google_search_term"] = " ".join(parts)
    # Work-mode filter: jobspy exposes is_remote across its supported boards. Only set it
    # when the request explicitly asks for remote — otherwise leave results unfiltered.
    if request.get("remote"):
        kwargs["is_remote"] = True
    if request.get("proxies"):
        kwargs["proxies"] = request["proxies"]

    frame = scrape_jobs(**kwargs)
    records = frame.to_dict(orient="records") if frame is not None else []
    print(json.dumps({"ok": True, "source": source, "jobs": clean(records)}, ensure_ascii=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc), "type": exc.__class__.__name__}, ensure_ascii=True))
        sys.exit(1)
