"""Drive jev_ultrafast.Agent on an arbitrary url/goal, completely unmodified
(same public Agent/Browser API and continuous-screencast technique their own
scripts/record_flights.py uses), while printing readable breadcrumbs and
saving a continuous video of the run plus a JSON log of every decision.

Not a modification of their library: everything here is their own
documented public surface (jev_ultrafast.Agent, agent.browser.call, and
browser_harness.helpers.drain_events, which record_flights.py itself uses).
"""

import argparse
import base64
import json
import subprocess
import sys
import threading
import time
from pathlib import Path

from browser_harness.helpers import drain_events

from jev_ultrafast import Agent

parser = argparse.ArgumentParser()
parser.add_argument("--url", required=True)
parser.add_argument("--goal", required=True)
parser.add_argument("--out-dir", required=True)
args = parser.parse_args()

out = Path(args.out_dir)
out.mkdir(parents=True, exist_ok=True)
frames_dir = out / "screencast"
frames_dir.mkdir(exist_ok=True)
breadcrumbs = []


def log(line: str) -> None:
    print(line, flush=True)
    breadcrumbs.append(line)


def fmt_tokens(usage: dict) -> str:
    return f"in={usage.get('input_tokens', '?')} out={usage.get('output_tokens', '?')}"


t_script_start = time.monotonic()
log(f"[{0.0:7.2f}s] launching one tab (kept open for the whole run) -> {args.url}")
agent = Agent(args.url, args.goal)
log(f"[{time.monotonic() - t_script_start:7.2f}s] website loaded: {agent.state['page']['url']!r} "
    f"title={agent.state['page']['title']!r}")

(out / "frames").mkdir(exist_ok=True)
(out / "frames" / "000000.jpg").write_bytes(
    base64.b64decode(agent.browser.call("Page.captureScreenshot", format="jpeg", quality=85)["data"])
)

stop = threading.Event()
screencast_epoch = time.time()
capture_errors = []


def capture():
    try:
        while not stop.is_set():
            for event in drain_events():
                if event["method"] != "Page.screencastFrame" or event.get("session_id") != agent.browser.session:
                    continue
                p = event["params"]
                ts = max(0, round((p["metadata"]["timestamp"] - screencast_epoch) * 1000))
                (frames_dir / f"{ts:06d}.jpg").write_bytes(base64.b64decode(p["data"]))
                agent.browser.call("Page.screencastFrameAck", sessionId=p["sessionId"])
            stop.wait(0.015)
    except Exception as e:
        capture_errors.append(str(e))


agent.browser.call("Page.startScreencast", format="jpeg", quality=80, maxWidth=1120, maxHeight=780, everyNthFrame=2)
worker = threading.Thread(target=capture, daemon=True)
worker.start()
screencast_epoch = time.time()

seen_decisions = 0
seen_history = 0
run_error = None
try:
    for state in agent.run():
        t = time.monotonic() - t_script_start
        decisions = state["decisions"]
        if len(decisions) > seen_decisions:
            d = decisions[-1]
            q = d["request"]["questions"]
            ops = list(q.get("operation", {}).get("criteria", {}).keys())
            log(f"[{t:7.2f}s] inputs passed to jev: operation-choices={ops} "
                f"page={d['request']['state']['page']['url']!r}")
            log(f"[{t:7.2f}s] jev decision: operation={d['operation']!r} target={d['target']!r} "
                f"confidence={d['confidence']:.2f} probabilities={d['probabilities']} "
                f"model={d['model']!r} tokens=({fmt_tokens(d['usage'])})")
            log(f"[{t:7.2f}s] time taken (jev call): {d['latency_ms']} ms")
            seen_decisions = len(decisions)
        history = state["history"]
        if len(history) > seen_history:
            h = history[-1]
            typed = f" text={h['text']!r} (helper={h['text_helper']!r}, {h['text_latency_ms']}ms)" if h["text"] else ""
            log(f"[{t:7.2f}s] browser performed action: {h['action']!r} (kind={h['kind']}){typed} "
                f"-> page_changed={h['page_changed']} url={h['url']!r}")
            seen_history = len(history)
        log(f"[{t:7.2f}s] status: {state['status']}")
except Exception as e:
    run_error = f"{type(e).__name__}: {e}"
    log(f"[{time.monotonic() - t_script_start:7.2f}s] RAISED (unhandled by their library): {run_error}")
finally:
    time.sleep(0.08)
    stop.set()
    worker.join(timeout=3)
    try:
        agent.browser.call("Page.stopScreencast")
    except Exception:
        pass
    final_snapshot = agent.snapshot()
    agent.close()

jev_cost = sum(d["usage"].get("input_tokens", 0) for d in final_snapshot["decisions"]) / 1_000_000 * 0.042
text_cost = sum(c["usage"].get("cost", 0) for c in final_snapshot["text_calls"])
log(f"[{time.monotonic() - t_script_start:7.2f}s] done. status={final_snapshot['status']!r} "
    f"decisions={len(final_snapshot['decisions'])} actions={len(final_snapshot['history'])} "
    f"jev_cost_usd={jev_cost:.6f} text_helper_cost_usd={text_cost:.6f} "
    f"screencast_frames={len(list(frames_dir.glob('*.jpg')))} capture_errors={capture_errors}")

(out / "state.json").write_text(json.dumps({**final_snapshot, "run_error": run_error}, indent=2, default=str))
(out / "breadcrumbs.log").write_text("\n".join(breadcrumbs) + "\n")

# Render the continuous screencast into a real video: resample the
# irregularly-timed CDP frames onto a fixed 15fps timeline (same technique
# their own scripts/render_demo.py uses), no branding overlay.
frame_files = [(0, out / "frames" / "000000.jpg")] + sorted((int(p.stem), p) for p in frames_dir.glob("*.jpg"))
if frame_files:
    end_ms = final_snapshot["elapsed_ms"]
    video_frames = out / "video_frames"
    video_frames.mkdir(exist_ok=True)
    fps = 15
    n = max(1, round((end_ms + 500) * fps / 1000))
    from PIL import Image

    for i in range(n):
        t_ms = min(end_ms, round(i * 1000 / fps))
        path = next(p for ts, p in reversed(frame_files) if ts <= t_ms)
        Image.open(path).convert("RGB").save(video_frames / f"{i:05d}.jpg")
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(fps), "-i", str(video_frames / "%05d.jpg"),
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart",
         str(out / "run.mp4")],
        check=True,
    )
    print(f"video: {out / 'run.mp4'}")
print(f"state log: {out / 'state.json'}")
print(f"breadcrumbs: {out / 'breadcrumbs.log'}")
if run_error:
    sys.exit(1)
