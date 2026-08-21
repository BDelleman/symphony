#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# ///

import asyncio
import argparse
import json
import os
import random
import re
import sys
from dataclasses import dataclass
from datetime import datetime
from typing import Any

POLL_SECONDS = 10
CHECKS_APPEAR_TIMEOUT_SECONDS = 120
CODEX_BOTS = {
    "chatgpt-codex-connector[bot]",
    "github-actions[bot]",
    "codex-gc-app[bot]",
    "app/codex-gc-app",
}
MAX_GH_RETRIES = 5
BASE_GH_BACKOFF_SECONDS = 2
DEFAULT_TIMEOUT_SECONDS = 1800
IMPLEMENTATION_REQUIRED_CHECKS = ("Fast validation (ubuntu-latest)",)
LANDING_REQUIRED_CHECKS = (
    "Fast validation (ubuntu-latest)",
    "Integration validation (ubuntu-latest)",
    "Windows install and build (windows-latest)",
)


@dataclass
class WatchOptions:
    mode: str
    expected_head: str | None
    expected_base: str | None
    json_output: bool
    timeout_seconds: int
    require_reviewer_app_approval: bool


@dataclass
class PrInfo:
    number: int
    url: str
    head_sha: str
    base_sha: str
    state: str
    is_draft: bool
    mergeable: str | None
    merge_state: str | None


class RateLimitError(RuntimeError):
    pass


def is_rate_limit_error(error: str) -> bool:
    return "HTTP 429" in error or "rate limit" in error.lower()


async def run_gh(*args: str) -> str:
    max_delay = BASE_GH_BACKOFF_SECONDS * (2 ** (MAX_GH_RETRIES - 1))
    delay_seconds = BASE_GH_BACKOFF_SECONDS
    last_error = "gh command failed"
    for attempt in range(1, MAX_GH_RETRIES + 1):
        proc = await asyncio.create_subprocess_exec(
            "gh",
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        if proc.returncode == 0:
            return stdout.decode()
        error = stderr.decode().strip() or "gh command failed"
        if not is_rate_limit_error(error):
            raise RuntimeError(error)
        last_error = error
        if attempt >= MAX_GH_RETRIES:
            break
        jitter = random.uniform(0, delay_seconds)
        await asyncio.sleep(min(delay_seconds + jitter, max_delay))
        delay_seconds = min(delay_seconds * 2, max_delay)
    raise RateLimitError(last_error)


async def get_pr_info() -> PrInfo:
    data = await run_gh(
        "pr",
        "view",
        "--json",
        "number,url,headRefOid,baseRefOid,state,isDraft,mergeable,mergeStateStatus",
    )
    parsed = json.loads(data)
    return PrInfo(
        number=parsed["number"],
        url=parsed["url"],
        head_sha=parsed["headRefOid"],
        base_sha=parsed["baseRefOid"],
        state=parsed["state"],
        is_draft=bool(parsed["isDraft"]),
        mergeable=parsed.get("mergeable"),
        merge_state=parsed.get("mergeStateStatus"),
    )


async def get_paginated_list(endpoint: str) -> list[dict[str, Any]]:
    page = 1
    items: list[dict[str, Any]] = []
    while True:
        data = await run_gh(
            "api",
            "--method",
            "GET",
            endpoint,
            "-f",
            "per_page=100",
            "-f",
            f"page={page}",
        )
        batch = json.loads(data)
        if not batch:
            break
        items.extend(batch)
        page += 1
    return items


async def get_issue_comments(pr_number: int) -> list[dict[str, Any]]:
    return await get_paginated_list(
        f"repos/{{owner}}/{{repo}}/issues/{pr_number}/comments",
    )


async def get_review_comments(pr_number: int) -> list[dict[str, Any]]:
    return await get_paginated_list(
        f"repos/{{owner}}/{{repo}}/pulls/{pr_number}/comments",
    )


async def get_reviews(pr_number: int) -> list[dict[str, Any]]:
    page = 1
    reviews: list[dict[str, Any]] = []
    while True:
        data = await run_gh(
            "api",
            "--method",
            "GET",
            f"repos/{{owner}}/{{repo}}/pulls/{pr_number}/reviews",
            "-f",
            "per_page=100",
            "-f",
            f"page={page}",
        )
        batch = json.loads(data)
        if not batch:
            break
        reviews.extend(batch)
        page += 1
    return reviews


async def get_check_runs(head_sha: str) -> list[dict[str, Any]]:
    page = 1
    check_runs: list[dict[str, Any]] = []
    while True:
        data = await run_gh(
            "api",
            "--method",
            "GET",
            f"repos/{{owner}}/{{repo}}/commits/{head_sha}/check-runs",
            "-f",
            "per_page=100",
            "-f",
            f"page={page}",
        )
        payload = json.loads(data)
        batch = payload.get("check_runs", [])
        if not batch:
            break
        check_runs.extend(batch)
        total_count = payload.get("total_count")
        if total_count is not None and len(check_runs) >= total_count:
            break
        page += 1
    return check_runs


def parse_time(value: str) -> datetime:
    normalized = value.replace("Z", "+00:00")
    return datetime.fromisoformat(normalized)


CONTROL_CHARS_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")


def sanitize_terminal_output(value: str) -> str:
    return CONTROL_CHARS_RE.sub("", value)


def check_timestamp(check: dict[str, Any]) -> datetime | None:
    for key in ("completed_at", "started_at", "run_started_at", "created_at"):
        value = check.get(key)
        if value:
            return parse_time(value)
    return None


def dedupe_check_runs(check_runs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    latest_by_name: dict[str, dict[str, Any]] = {}
    for check in check_runs:
        name = check.get("name", "unknown")
        timestamp = check_timestamp(check)
        if name not in latest_by_name:
            latest_by_name[name] = check
            continue
        existing = latest_by_name[name]
        existing_timestamp = check_timestamp(existing)
        if timestamp is None:
            continue
        if existing_timestamp is None or timestamp > existing_timestamp:
            latest_by_name[name] = check
    return list(latest_by_name.values())


def summarize_checks(
    check_runs: list[dict[str, Any]],
    required_names: tuple[str, ...],
) -> tuple[bool, bool, list[str]]:
    latest_by_name = {check.get("name", "unknown"): check for check in dedupe_check_runs(check_runs)}
    pending = False
    failed = False
    failures: list[str] = []
    for name in required_names:
        check = latest_by_name.get(name)
        if check is None:
            pending = True
            continue
        status = check.get("status")
        conclusion = check.get("conclusion")
        if status != "completed":
            pending = True
            continue
        if conclusion != "success":
            failed = True
            failures.append(f"{name}: {conclusion}")
    return pending, failed, failures


def latest_review_request_at(comments: list[dict[str, Any]]) -> datetime | None:
    latest: datetime | None = None
    for comment in comments:
        if is_codex_bot_user(comment.get("user", {})):
            continue
        body = comment.get("body") or ""
        if "@codex review" not in body:
            continue
        timestamp = comment_time(comment)
        if timestamp is None:
            continue
        if latest is None or timestamp > latest:
            latest = timestamp
    return latest


def filter_codex_comments(
    comments: list[dict[str, Any]],
    review_requested_at: datetime | None,
) -> list[dict[str, Any]]:
    latest_codex_reply = latest_codex_reply_by_thread(comments)
    latest_issue_ack = latest_codex_issue_reply_time(comments)
    codex_comments = [c for c in comments if is_codex_bot_user(c.get("user", {}))]
    filtered: list[dict[str, Any]] = []
    for comment in codex_comments:
        created_time = comment_time(comment)
        if created_time is None:
            continue
        if review_requested_at is not None and created_time <= review_requested_at:
            continue
        is_threaded = bool(
            comment.get("in_reply_to_id") or comment.get("pull_request_review_id")
        )
        if not is_threaded:
            if latest_issue_ack is not None and created_time <= latest_issue_ack:
                continue
        else:
            thread_root = thread_root_id(comment)
            last_reply = None
            if thread_root is not None:
                last_reply = latest_codex_reply.get(thread_root)
            if last_reply and last_reply > created_time:
                continue
        filtered.append(comment)
    return filtered


def is_codex_bot_user(user: dict[str, Any]) -> bool:
    login = user.get("login") or ""
    return login in CODEX_BOTS


def is_bot_user(user: dict[str, Any]) -> bool:
    login = user.get("login") or ""
    if is_codex_bot_user(user):
        return True
    if user.get("type") == "Bot":
        return True
    return login.endswith("[bot]")


def is_codex_reply_body(body: str) -> bool:
    return body.startswith("[codex]")


def is_codex_review_body(body: str) -> bool:
    return body.startswith("## Codex Review")


def latest_codex_issue_reply_time(
    comments: list[dict[str, Any]],
) -> datetime | None:
    latest: datetime | None = None
    for comment in comments:
        body = (comment.get("body") or "").strip()
        if not is_codex_reply_body(body):
            continue
        created_time = comment_time(comment)
        if created_time is None:
            continue
        if latest is None or created_time > latest:
            latest = created_time
    return latest


def filter_human_issue_comments(comments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    latest_ack = latest_codex_issue_reply_time(comments)
    filtered: list[dict[str, Any]] = []
    for comment in comments:
        if is_bot_user(comment.get("user", {})):
            continue
        body = (comment.get("body") or "").strip()
        if is_codex_reply_body(body):
            continue
        if is_codex_review_body(body):
            continue
        if "@codex review" in body:
            continue
        created_time = comment_time(comment)
        if (
            latest_ack is not None
            and created_time is not None
            and created_time <= latest_ack
        ):
            continue
        filtered.append(comment)
    return filtered


def filter_codex_review_issue_comments(
    comments: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    latest_ack = latest_codex_issue_reply_time(comments)
    filtered: list[dict[str, Any]] = []
    for comment in comments:
        body = (comment.get("body") or "").strip()
        if not is_codex_review_body(body):
            continue
        created_time = comment_time(comment)
        if (
            latest_ack is not None
            and created_time is not None
            and created_time <= latest_ack
        ):
            continue
        filtered.append(comment)
    return filtered


def thread_root_id(comment: dict[str, Any]) -> int | None:
    return comment.get("in_reply_to_id") or comment.get("id")


def comment_time(comment: dict[str, Any]) -> datetime | None:
    timestamp = comment.get("updated_at") or comment.get("created_at")
    if not timestamp:
        return None
    return parse_time(timestamp)


def latest_codex_reply_by_thread(
    comments: list[dict[str, Any]],
) -> dict[int, datetime]:
    latest: dict[int, datetime] = {}
    for comment in comments:
        body = (comment.get("body") or "").strip()
        if not is_codex_reply_body(body):
            continue
        thread_root = thread_root_id(comment)
        created_time = comment_time(comment)
        if thread_root is None or created_time is None:
            continue
        existing = latest.get(thread_root)
        if existing is None or created_time > existing:
            latest[thread_root] = created_time
    return latest


def filter_human_review_comments(
    comments: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    latest_codex_reply = latest_codex_reply_by_thread(comments)
    filtered: list[dict[str, Any]] = []
    for comment in comments:
        if is_bot_user(comment.get("user", {})):
            continue
        body = (comment.get("body") or "").strip()
        if is_codex_reply_body(body):
            continue
        thread_root = thread_root_id(comment)
        created_time = comment_time(comment)
        last_codex_reply = None
        if thread_root is not None:
            last_codex_reply = latest_codex_reply.get(thread_root)
        if last_codex_reply and created_time and created_time <= last_codex_reply:
            continue
        filtered.append(comment)
    return filtered


def is_blocking_review(
    review: dict[str, Any],
    review_requested_at: datetime | None,
) -> bool:
    created_at = review.get("submitted_at") or review.get("created_at")
    if not created_at:
        return False
    user_login = review.get("user", {}).get("login")
    created_time = parse_time(created_at)
    if (
        user_login in CODEX_BOTS
        and review_requested_at is not None
        and created_time <= review_requested_at
    ):
        return False
    body = (review.get("body") or "").strip()
    state = review.get("state")
    if user_login in CODEX_BOTS:
        return state == "CHANGES_REQUESTED"
    if body.startswith("[codex]") or state in ("APPROVED", "DISMISSED"):
        return False
    blocking = False
    if body or state == "CHANGES_REQUESTED":
        blocking = True
    elif state == "COMMENTED":
        blocking = False
    elif state:
        blocking = state not in ("APPROVED", "DISMISSED")
    return blocking


def review_timestamp(review: dict[str, Any]) -> datetime | None:
    created_at = review.get("submitted_at") or review.get("created_at")
    if not created_at:
        return None
    return parse_time(created_at)


def dedupe_reviews(reviews: list[dict[str, Any]]) -> list[dict[str, Any]]:
    latest_by_user: dict[str, dict[str, Any]] = {}
    for review in reviews:
        user_login = review.get("user", {}).get("login")
        if not user_login:
            continue
        timestamp = review_timestamp(review)
        if user_login not in latest_by_user:
            latest_by_user[user_login] = review
            continue
        existing = latest_by_user[user_login]
        existing_timestamp = review_timestamp(existing)
        if timestamp is None:
            continue
        if existing_timestamp is None or timestamp > existing_timestamp:
            latest_by_user[user_login] = review
    return list(latest_by_user.values())


def filter_blocking_reviews(
    reviews: list[dict[str, Any]],
    review_requested_at: datetime | None,
) -> list[dict[str, Any]]:
    return [
        review
        for review in dedupe_reviews(reviews)
        if is_blocking_review(review, review_requested_at)
    ]


def require_reviewer_app_approval(reviews: list[dict[str, Any]], head_sha: str) -> None:
    expected_login = os.environ.get(
        "SYMPHONY_REVIEWER_APP_LOGIN",
        "symphony-reviewer[bot]",
    ).strip().lower()
    matching = [
        review
        for review in reviews
        if review.get("user", {}).get("login", "").lower() == expected_login
        and review.get("state") == "APPROVED"
        and review.get("commit_id") == head_sha
    ]
    if not matching:
        raise RuntimeError(
            f"reviewer_app_exact_head_approval_missing:login={expected_login}:head={head_sha}",
        )


def is_merge_conflicting(pr: PrInfo) -> bool:
    return pr.mergeable == "CONFLICTING" or pr.merge_state == "DIRTY"


async def fetch_review_context(
    pr_number: int,
) -> tuple[
    list[dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
    datetime | None,
]:
    issue_comments = await get_issue_comments(pr_number)
    review_request_at = latest_review_request_at(issue_comments)
    review_comments = await get_review_comments(pr_number)
    reviews = await get_reviews(pr_number)
    return issue_comments, review_comments, reviews, review_request_at


def raise_on_human_feedback(
    issue_comments: list[dict[str, Any]],
    review_comments: list[dict[str, Any]],
    reviews: list[dict[str, Any]],
    review_request_at: datetime | None,
) -> None:
    human_issue_comments = filter_human_issue_comments(issue_comments)
    codex_review_comments = filter_codex_review_issue_comments(issue_comments)
    human_review_comments = filter_human_review_comments(review_comments)
    if human_issue_comments or human_review_comments or codex_review_comments:
        print("Review comments detected. Address before merge.")
        print(
            "Reminder: decide whether feedback stays in scope; defer if needed "
            "and note in your root-level update.",
        )
        raise SystemExit(2)
    blocking_reviews = filter_blocking_reviews(reviews, review_request_at)
    if blocking_reviews:
        print("Review states/comments detected. Address before merge.")
        print(
            "Reminder: keep PR title/description aligned with the full scope "
            "when changes expand.",
        )
        raise SystemExit(2)


async def wait_for_codex(pr_number: int, checks_done: asyncio.Event) -> None:
    print("Waiting for review feedback...", flush=True)
    while True:
        await assert_no_review_feedback(pr_number)
        if checks_done.is_set():
            return
        await asyncio.sleep(POLL_SECONDS)


async def assert_no_review_feedback(pr_number: int) -> None:
    issue_comments, review_comments, reviews, review_request_at = await fetch_review_context(pr_number)
    raise_on_human_feedback(issue_comments, review_comments, reviews, review_request_at)
    bot_comments = filter_codex_comments(issue_comments, review_request_at) + filter_codex_comments(
        review_comments,
        review_request_at,
    )
    if not bot_comments:
        return
    latest = max(bot_comments, key=lambda comment: parse_time(comment["created_at"]))
    body = sanitize_terminal_output(latest.get("body") or "").strip()
    if body:
        print("Codex left comments. Address feedback before merge.")
        print(body)
        raise SystemExit(2)


async def wait_for_checks(
    head_sha: str,
    checks_done: asyncio.Event,
    required_names: tuple[str, ...],
) -> None:
    print("Waiting for CI checks...", flush=True)
    empty_seconds = 0
    while True:
        check_runs = await get_check_runs(head_sha)
        observed_names = {check.get("name", "unknown") for check in dedupe_check_runs(check_runs)}
        missing_names = [name for name in required_names if name not in observed_names]
        if missing_names:
            empty_seconds += POLL_SECONDS
            if empty_seconds >= CHECKS_APPEAR_TIMEOUT_SECONDS:
                print(f"Required checks not detected after 120s: {', '.join(missing_names)}")
                raise SystemExit(3)
            await asyncio.sleep(POLL_SECONDS)
            continue
        empty_seconds = 0
        pending, failed, failures = summarize_checks(check_runs, required_names)
        if failed:
            print("Checks failed:")
            for failure in failures:
                print(f"- {failure}")
            raise SystemExit(3)
        if not pending:
            print("Checks passed")
            checks_done.set()
            return
        await asyncio.sleep(POLL_SECONDS)


async def watch_pr(options: WatchOptions) -> dict[str, Any]:
    started_at = asyncio.get_running_loop().time()
    pr = await get_pr_info()
    if pr.state != "OPEN" or pr.is_draft:
        raise RuntimeError(f"pr_not_open_or_ready:state={pr.state}:draft={pr.is_draft}")
    if options.expected_head and pr.head_sha != options.expected_head:
        raise RuntimeError(
            f"expected_head_mismatch:expected={options.expected_head}:actual={pr.head_sha}",
        )
    if options.expected_base and pr.base_sha != options.expected_base:
        raise RuntimeError(
            f"expected_base_mismatch:expected={options.expected_base}:actual={pr.base_sha}",
        )
    if is_merge_conflicting(pr):
        print(
            "PR has merge conflicts. Resolve/rebase against main and push before "
            "running land_watch again.",
        )
        raise SystemExit(5)
    head_sha = pr.head_sha
    required_checks = (
        IMPLEMENTATION_REQUIRED_CHECKS
        if options.mode == "implementation-readiness"
        else LANDING_REQUIRED_CHECKS
    )
    checks_done = asyncio.Event()
    codex_task = asyncio.create_task(wait_for_codex(pr.number, checks_done))
    checks_task = asyncio.create_task(wait_for_checks(head_sha, checks_done, required_checks))

    async def head_monitor() -> None:
        while True:
            current = await get_pr_info()
            if current.state != "OPEN" or current.is_draft:
                raise RuntimeError(f"pr_not_open_or_ready:state={current.state}:draft={current.is_draft}")
            if is_merge_conflicting(current):
                print(
                    "PR has merge conflicts. Resolve/rebase against main and push "
                    "before running land_watch again.",
                )
                raise SystemExit(5)
            if current.head_sha != head_sha:
                print("PR head updated; pull/amend/force-push to retrigger CI")
                raise SystemExit(4)
            if options.expected_base and current.base_sha != options.expected_base:
                raise RuntimeError(
                    f"expected_base_mismatch:expected={options.expected_base}:actual={current.base_sha}",
                )
            await asyncio.sleep(POLL_SECONDS)

    monitor_task = asyncio.create_task(head_monitor())
    success_task = asyncio.gather(codex_task, checks_task)

    done, pending = await asyncio.wait(
        [monitor_task, success_task],
        return_when=asyncio.FIRST_COMPLETED,
    )
    for task in pending:
        task.cancel()
    for task in done:
        exc = task.exception()
        if exc:
            raise exc
    current = await get_pr_info()
    if current.head_sha != head_sha:
        raise RuntimeError(
            f"expected_head_mismatch:expected={head_sha}:actual={current.head_sha}",
        )
    if current.state != "OPEN" or current.is_draft:
        raise RuntimeError(f"pr_not_open_or_ready:state={current.state}:draft={current.is_draft}")
    if is_merge_conflicting(current):
        raise RuntimeError("pr_merge_conflict")
    if options.expected_base and current.base_sha != options.expected_base:
        raise RuntimeError(
            f"expected_base_mismatch:expected={options.expected_base}:actual={current.base_sha}",
        )
    pending_checks, failed_checks, failures = summarize_checks(await get_check_runs(head_sha), required_checks)
    if pending_checks or failed_checks:
        raise RuntimeError(f"required_checks_not_ready:{','.join(failures) if failures else 'pending'}")
    await assert_no_review_feedback(current.number)
    if options.mode == "landing-readiness" and options.require_reviewer_app_approval:
        require_reviewer_app_approval(await get_reviews(current.number), head_sha)
    return {
        "status": "ready",
        "mode": options.mode,
        "pr_number": current.number,
        "pr_url": current.url,
        "head_sha": current.head_sha,
        "base_sha": current.base_sha,
        "required_checks": list(required_checks),
        "duration_ms": round((asyncio.get_running_loop().time() - started_at) * 1000),
        "mergeable": current.mergeable,
        "merge_state": current.merge_state,
    }


def parse_args() -> WatchOptions:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--mode",
        choices=("implementation-readiness", "landing-readiness"),
        default="landing-readiness",
    )
    parser.add_argument("--expected-head")
    parser.add_argument("--expected-base")
    parser.add_argument("--require-reviewer-app-approval", action="store_true")
    parser.add_argument("--json", action="store_true", dest="json_output")
    parser.add_argument(
        "--timeout-seconds",
        type=int,
        default=int(os.environ.get("SYMPHONY_LAND_WATCH_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS)),
    )
    args = parser.parse_args()
    if args.timeout_seconds <= 0:
        parser.error("--timeout-seconds must be positive")
    return WatchOptions(
        mode=args.mode,
        expected_head=args.expected_head,
        expected_base=args.expected_base,
        json_output=args.json_output,
        timeout_seconds=args.timeout_seconds,
        require_reviewer_app_approval=args.require_reviewer_app_approval,
    )


if __name__ == "__main__":
    options = parse_args()
    try:
        result = asyncio.run(asyncio.wait_for(watch_pr(options), timeout=options.timeout_seconds))
        if options.json_output:
            print(json.dumps(result, sort_keys=True))
    except SystemExit as exc:
        raise SystemExit(exc.code) from None
    except asyncio.TimeoutError:
        if options.json_output:
            print(json.dumps({"status": "timed_out", "mode": options.mode}, sort_keys=True))
        raise SystemExit(6) from None
    except Exception as exc:
        if options.json_output:
            print(
                json.dumps(
                    {"status": "failed", "mode": options.mode, "reason": str(exc)},
                    sort_keys=True,
                ),
                file=sys.stdout,
            )
        else:
            print(str(exc), file=sys.stderr)
        raise SystemExit(7) from None
