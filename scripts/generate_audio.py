#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate differential Neural TTS MP3 files for flashcards."""

import asyncio
import json
import os
import re
import sys
import edge_tts

VOICE_MAP = {
    "zh-TW": "zh-TW-HsiaoChenNeural",
    "en-US": "en-US-AriaNeural",
    "ko-KR": "ko-KR-SunHiNeural",
    "zh-CN": "zh-CN-XiaoxiaoNeural",
    "fr-FR": "fr-FR-DeniseNeural",
    "de-DE": "de-DE-KatjaNeural",
}
JA_VOICE = "ja-JP-NanamiNeural"

# 日本語TTSが読み間違いやすい台湾固有名詞・料理名・略語の読み補正
JA_READ_FIXES = [
    ("蛋餅", "ダンビン"),
    ("滷肉飯", "ルーローハン"),
    ("牛肉麵", "ぎゅうにくめん"),
    ("牛肉麺", "ぎゅうにくめん"),
    ("牛肉湯", "ぎゅうにくスープ"),
    ("小籠包", "しょうろんぽう"),
    ("臭豆腐", "しゅうどうふ"),
    ("豆花", "トウファ"),
    ("悠遊カード", "ユーユーカード"),
    ("悠遊卡", "ユーユーカード"),
    ("九份", "きゅうふん"),
    ("猴硐", "ホウトン"),
    ("淡水", "たんすい"),
    ("象山", "ぞうざん"),
    ("基隆", "キールン"),
    ("澎湖", "ポンフー"),
    ("花蓮", "かれん"),
    ("花東縦谷", "かとうじゅうこく"),
    ("小琉球", "しょうりゅうきゅう"),
    ("忠孝復興駅", "ちゅうこうふっこうえき"),
    ("西門町", "せいもんちょう"),
    ("士林夜市", "しりんよいち"),
    ("陽明山", "ようめいざん"),
    ("誠品書店", "せいひんしょてん"),
    ("桃園空港", "とうえんくうこう"),
    ("故宮博物院", "こきゅうはくぶついん"),
    ("居留証", "きょりゅうしょう"),
    ("華語", "かご"),
    ("MRT", "エムアールティー"),
    ("SNS", "エスエヌエス"),
]

SAFE_ID_RE = re.compile(r"[^A-Za-z0-9_-]")


def sanitize_id(card_id: str) -> str:
    return SAFE_ID_RE.sub("_", str(card_id))


def preprocess_ja(text: str) -> str:
    out = text.strip()
    for src, dst in JA_READ_FIXES:
        out = out.replace(src, dst)
    return out


async def synthesize_with_retry(text: str, voice: str, out_path: str, sem: asyncio.Semaphore, retries: int = 3) -> bool:
    async with sem:
        tmp_path = f"{out_path}.tmp"
        for attempt in range(1, retries + 1):
            try:
                comm = edge_tts.Communicate(text=text, voice=voice)
                await comm.save(tmp_path)
                if os.path.exists(tmp_path) and os.path.getsize(tmp_path) > 0:
                    os.replace(tmp_path, out_path)
                    return True
            except Exception as exc:
                if attempt == retries:
                    print(f"[WARN] Failed {out_path} ({voice}): {exc}", file=sys.stderr)
                await asyncio.sleep(1.2 * attempt)
            finally:
                if os.path.exists(tmp_path):
                    try:
                        os.remove(tmp_path)
                    except OSError:
                        pass
        return False


async def main():
    json_path = sys.argv[1] if len(sys.argv) > 1 else "data/flashcards.json"
    audio_dir = sys.argv[2] if len(sys.argv) > 2 else "audio"

    if not os.path.exists(json_path):
        print(f"JSON file not found: {json_path}")
        return

    os.makedirs(audio_dir, exist_ok=True)

    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    decks = {d["id"]: d for d in data.get("decks", []) if isinstance(d, dict) and d.get("id")}
    cards = data.get("cards", []) if isinstance(data, dict) else data

    sem = asyncio.Semaphore(6)
    tasks = []

    for card in cards:
        cid = sanitize_id(card.get("id", ""))
        if not cid:
            continue
        deck = decks.get(card.get("deckId", ""), {})
        lang = deck.get("lang", "zh-TW")
        ex_voice = VOICE_MAP.get(lang, VOICE_MAP["zh-TW"])

        example = (card.get("example") or "").strip()
        example_ja = (card.get("exampleJa") or "").strip()

        if example:
            ex_path = os.path.join(audio_dir, f"{cid}-ex.mp3")
            if not (os.path.exists(ex_path) and os.path.getsize(ex_path) > 0):
                tasks.append(synthesize_with_retry(example, ex_voice, ex_path, sem))

        if example_ja:
            ja_path = os.path.join(audio_dir, f"{cid}-ja.mp3")
            if not (os.path.exists(ja_path) and os.path.getsize(ja_path) > 0):
                tasks.append(synthesize_with_retry(preprocess_ja(example_ja), JA_VOICE, ja_path, sem))

    if not tasks:
        print("All audio files are already up to date.")
        return

    print(f"Generating {len(tasks)} new MP3 files...")
    results = await asyncio.gather(*tasks)
    ok = sum(1 for r in results if r)
    print(f"Completed: {ok}/{len(tasks)} generated.")


if __name__ == "__main__":
    asyncio.run(main())
