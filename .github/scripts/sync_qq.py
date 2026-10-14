#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""蛇杖二号 · 刷新「官网公告待办」静态快照（data/todo.json）

════════════════════════════════════════════════════════════════════
2026-10-14 改版：从「镜像一号」改成「从自己云函数实时抓」
────────────────────────────────────────────────────────────────────
原做法：本脚本把蛇杖一号的 data/todo.json **原样镜像**到二号。
      但一号的抓取管线早已停摆（停在 2026-10-03），于是二号也跟着冻住 ——
      「无变化，跳过提交」天天跑，页面那份快照永远是一周前的。前端那个
      「刷新」按钮更是只是把同一份旧文件重下一遍，点了等于没点。

新做法：本脚本调**蛇杖二号自己的云函数** `/campus` 端点（服务端当场抓
      广西医科大学官网各栏目、解析成结构化公告），写成本仓库的
      data/todo.json —— 这份是**静态兜底**：当某台设备连不上云函数时，
      页面会回落读它。实时那一路直接走云函数，不经过本文件。

两条硬保证：
  1) 只读公开信息：/campus 抓的是校网公开栏目 + 一号公开文件，不涉任何群聊内容。
  2) 隐私红线：本文件恒 include_qq=false；workflow 起手还有一道红线自检。

由 .github/workflows/sync-todo.yml 每 30 分钟调用一次（也可手动 dispatch）。
"""
import json
import os
import sys
import time
import urllib.request

# 蛇杖二号自己的云函数（公开地址，页面同款）
CLOUD = "https://1499683192-953ux74r8x.ap-guangzhou.tencentscf.com"
# 云函数抓不动时的兜底：镜像一号公开文件（基本不会再触发）
SZ1 = "https://raw.githubusercontent.com/bicheng2026/shezhang1/main/"

OUT = os.path.join("data", "todo.json")
NOTE = "实时抓取自广西医科大学官网（云函数 /campus）；本文件为静态兜底"


def _get_json(url, tries=3):
    last = None
    for _ in range(tries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": "sz2-sync", "Cache-Control": "no-cache"})
            with urllib.request.urlopen(req, timeout=45) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:
            last = e
            time.sleep(3)
    raise last


def from_cloud():
    """主路：调自己云函数 /campus 实时抓。"""
    j = _get_json(CLOUD + "/campus?limit=200&refresh=1&t=" + str(int(time.time() * 1000)), tries=2)
    items = (j or {}).get("items") or []
    if not items:
        return None
    return {
        "updated_at": j.get("updated_at") or time.strftime("%Y-%m-%d %H:%M:%S"),
        "count": len(items),
        "include_qq": False,
        "note": NOTE,
        "items": items,
    }


def from_sz1():
    """兜底：镜像一号的公开 todo.json（基本不会触发）。"""
    j = _get_json(SZ1 + "data/todo.json?t=" + str(int(time.time() * 1000)), tries=2)
    items = (j or {}).get("items") or []
    if not items:
        return None
    return {
        "updated_at": j.get("updated_at") or time.strftime("%Y-%m-%d %H:%M:%S"),
        "count": len(items),
        "include_qq": False,
        "note": "镜像自蛇杖一号（云函数不可用时的兜底）",
        "items": items,
    }


def load_local():
    try:
        with open(OUT, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def main():
    new = None
    try:
        new = from_cloud()
        if new:
            print("[云函数] /campus 取到 %d 条" % new["count"])
    except Exception as e:
        print("[云函数] 失败：%r" % e)

    if not new:
        try:
            new = from_sz1()
            if new:
                print("[兜底] 一号镜像取到 %d 条" % new["count"])
        except Exception as e:
            print("[兜底] 一号也失败：%r" % e)

    if not new:
        print("两路都没取到，保持原文件不动。")
        return 0

    old = load_local()
    if old and json.dumps(old.get("items"), sort_keys=True, ensure_ascii=False) == \
              json.dumps(new.get("items"), sort_keys=True, ensure_ascii=False):
        print("[无变化] %d 条" % new["count"])
        return 0

    d = os.path.dirname(OUT)
    if d:
        os.makedirs(d, exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(new, f, ensure_ascii=False, indent=2)
    oldn = len((old or {}).get("items") or [])
    print("[已更新] %d → %d 条" % (oldn, new["count"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
