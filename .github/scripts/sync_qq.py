#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""蛇杖二号 · 从蛇杖一号同步「官网公告待办」

⚠️ 2026-10-04 变更：班群摘要不再同步到公开仓库
----------------------------------------------------------------
原来这份脚本会一并拉一号的 data/qq_digest.json（班群消息摘要）推进二号公开仓库。
但主公 2026-09-30 立下的红线优先级高于一切历史决策：

    「群聊内容（QQ群/班级群）只落本机，绝不推进任何公开仓库。」

那份摘要此前长期挂在公开 GitHub 上全网可读（内容涉及班级报名、补报名截止、
志愿时长、义诊培训等内部事务），已于 2026-10-04 从远端删除（commit 9e2b079）。
本脚本据此摘掉 qq_digest 的同步，只留官网公告。
本机还留着那份文件供本地看板使用 —— 本机可以读，公网不行。

起作用的三条硬保证：
  1. 只读一号的【公开数据文件】，不碰一号任何写接口、不碰一号云函数 → 一号完全无感。
  2. 只对 data/todo.json 做镜像 —— 那是纯官网/图书馆公告，本来就是公开信息，
     也是 Agent 的 get_todo 工具唯一数据源。
  3. 无凭据：只读 public 仓库的 raw 文件，脚本里不出现任何 token。
  4. 班群内容零触碰：同步清单里不再出现任何 qq_* 文件。

由 .github/workflows/sync-todo.yml 每 30 分钟调用一次。
"""
import json
import os
import sys
import time
import urllib.request

SZ1 = "https://raw.githubusercontent.com/bicheng2026/shezhang1/main/"

# (本地路径, 远端路径, 模式) —— union: 按 id 并集合并；mirror: 一号为权威源直接镜像
#
# ⚠️ 2026-10-04：这里原本还有一行 qq_digest.json 的 union 同步，已按隐私红线删除。
#    班群内容不进任何公开仓库，一号二号都不进。本机要用的话走本地 bridge 写文件，
#    那份文件只在本地（.gitignore 已排除），不上云、不跨库。
FILES = [
    ("data/todo.json", "data/todo.json", "mirror"),
]


def fetch(rel, tries=3):
    url = SZ1 + rel + "?t=" + str(int(time.time() * 1000))     # 绕 raw 的 CDN 缓存
    last = None
    for _ in range(tries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": "sz2-sync", "Cache-Control": "no-cache"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:                                  # 网络抖动重试
            last = e
            time.sleep(3)
    raise last


def load_local(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def items_of(o):
    if isinstance(o, list):
        return o
    if isinstance(o, dict):
        return o.get("items") or []
    return []


def merge_union(local_items, remote_items):
    """本地在前、远端在后，按 id 去重（本地优先保序），只增不减。"""
    seen, out = set(), []
    for it in list(local_items) + list(remote_items):
        if not isinstance(it, dict):
            continue
        k = it.get("id") or it.get("text") or json.dumps(it, sort_keys=True, ensure_ascii=False)
        if k in seen:
            continue
        seen.add(k)
        out.append(it)
    out.sort(key=lambda x: (x.get("time") or "", x.get("timeText") or ""), reverse=True)
    return out


def main():
    changed_any = False
    for local_rel, remote_rel, mode in FILES:
        local_rel = local_rel.replace("/", os.sep)
        try:
            remote = fetch(remote_rel)
        except Exception as e:
            print("[跳过] %s 拉取失败：%r" % (remote_rel, e))
            continue

        local = load_local(local_rel)

        if mode == "mirror":
            new_obj = remote
            old_items = items_of(local)
            new_items = items_of(remote)
            same = (json.dumps(old_items, sort_keys=True, ensure_ascii=False)
                    == json.dumps(new_items, sort_keys=True, ensure_ascii=False))
            if same:
                print("[无变化] %s（%d 条）" % (local_rel, len(new_items)))
                continue
            desc = "%d → %d 条" % (len(old_items), len(new_items))
        else:
            local_items = items_of(local)
            remote_items = items_of(remote)
            merged = merge_union(local_items, remote_items)
            if len(merged) < len(local_items):          # 安全阀：绝不缩小
                merged = local_items
            same = (len(merged) == len(local_items)
                    and json.dumps(merged, sort_keys=True, ensure_ascii=False)
                    == json.dumps(local_items, sort_keys=True, ensure_ascii=False))
            if same:
                print("[无变化] %s（%d 条）" % (local_rel, len(merged)))
                continue
            new_obj = dict(local) if isinstance(local, dict) else {}
            if isinstance(remote, dict) and remote.get("note"):
                new_obj["note"] = remote["note"]
            new_obj["count"] = len(merged)
            new_obj["updated"] = int(time.time() * 1000)
            new_obj["updated_text"] = time.strftime("%Y-%m-%d %H:%M", time.localtime())
            new_obj["items"] = merged
            desc = "%d → %d 条" % (len(local_items), len(merged))

        d = os.path.dirname(local_rel)
        if d:
            os.makedirs(d, exist_ok=True)
        with open(local_rel, "w", encoding="utf-8") as f:
            json.dump(new_obj, f, ensure_ascii=False, indent=2)
        print("[已更新] %s  %s" % (local_rel, desc))
        changed_any = True

    print("完成" if changed_any else "完成（无变化）")


if __name__ == "__main__":
    sys.exit(main())
