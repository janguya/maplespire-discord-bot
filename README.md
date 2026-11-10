# maplespire-discord-bot

모험가의 길(MapleSpire) 디스코드 서버의 자동 감시 봇. **Cloudflare Workers**의 크론 트리거가 10분마다 `worker/src/index.js`를 실행합니다.

- **입장 인사**: #잡담-general(서버 시스템 채널)에 입장 메시지가 올라오면 디스코드 「손 흔들기」 버튼과 같은 기본 스티커로 답장합니다(스티커가 안 되면 👋 반응). 봇 계정 · 이미 나간 사람은 건너뜁니다.
- **새 소식 알림**: 포럼(질문 · 버그 제보 · 건의 · 번역 오류)의 새 글 · 새 댓글(봇 · 서버 주인 제외)을 모아 #moderator-only에 서버 주인을 멘션해 알립니다.

## Worker (`worker/`)
- 봇 토큰: Worker 비밀값 `DISCORD_BOT_TOKEN`(`wrangler secret put`, 코드 · 로그에 나오지 않음).
- 상태(어디까지 봤는지): KV 네임스페이스 `STATE`의 키 `state`. 없으면 첫 실행은 기준점만 기록하고 아무것도 보내지 않습니다.
- 대상 채널 · 스티커 목록 · 주기: `src/index.js` 맨 위 `FORUMS` · `NOTIFY_CHANNEL` · `WAVE_STICKERS`, `wrangler.toml`의 `crons`.
- 배포: `cd worker && npm install && npx wrangler deploy`. 실행 로그: `npx wrangler tail` 또는 Cloudflare 대시보드(Workers → maplespire-discord-bot → Logs).
- 로컬 시험(읽기만): `worker/.dev.vars`에 `DISCORD_BOT_TOKEN=…`, `DRY=1`, `LOCAL_RUN=1`을 넣고 `npx wrangler dev` → `http://127.0.0.1:8787/run`.

## GitHub Actions (`poll.py`) — 비상용
처음엔 GitHub Actions 예약 실행으로 돌렸으나 예약이 몇 시간씩 늦어(하루 2번) 11-10에 Cloudflare로 옮겼습니다. `discord-poll` 워크플로는 수동 실행만 남아 있습니다(Worker가 멈췄을 때만 — 상태가 Worker와 따로라 같이 돌리면 알림이 겹칠 수 있음).
