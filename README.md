# TV Guide

A self-updating XMLTV guide. Match each of your channels to a guide source once, and every app that uses the guide link picks up the listings automatically, including HD, HEVC and 4K versions of the same channel.

**Guide link (never changes):** `https://<you>.github.io/<repo>/guide.xml.gz`
(uncompressed: `…/guide.xml`)

**Matcher:** `https://<you>.github.io/<repo>/`

## How it works

1. Your channel list (names and tvg-ids only, never stream links) is kept in `data/channels.json`. It's refreshed nightly from the `M3U_URL` secret, or you can upload an .m3u from the matcher.
2. Every build automatically matches new channels when it's confident (marked "auto"). Your own picks and "No guide" choices are never changed. In the matcher you can review, fix or add the rest. Its **Auto-match** button pairs channels with guide sources (Sky, epgshare01, Freeview, TV24, MyTelly, EE, Virgin, DAZN, DirecTV, TV Insider — UK, Ireland, US incl. local stations, Canada) by cleaning up names: it ignores HD/FHD/HEVC/4K tags and "UK:" prefixes, and handles +1 channels. Review the matches, fix any by tapping them, then **Save**.
3. Saving updates `mappings.json`. GitHub Actions then fetches the listings with the open-source [iptv-org/epg](https://github.com/iptv-org/epg) grabber and publishes the guide under **your** tvg-ids. It also rebuilds every 3 hours.

Channels that share a tvg-id are matched together. Channels without a tvg-id are matched by name.

## Setup

1. **Settings → Pages → Source: GitHub Actions**
2. **Settings → Secrets and variables → Actions → New secret** `M3U_URL` = your playlist link (optional; you can upload a file in the matcher instead)
3. **Actions → Build guide → Run workflow**
4. Open the matcher and connect it with a fine-grained token (this repo only, *Contents: read and write*)

## Settings (`config.json`)

- `sites`: guide sources to offer, in order of preference (any site from iptv-org/epg's SITES.md)
- `skyRegions`: Sky regions to include (`GB`, `DE`, `IT`)
- `region`: preferred regional variant, e.g. `London` for ITV/BBC
- `days`: days of listings (default 3)
- `epgshareTags`: epgshare01 regions to include
- `skipGroups`: playlist groups that never have a guide (24/7, PPV, VOD) — hidden from the matcher and not auto-matched
