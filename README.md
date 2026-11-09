# maplespire-discord-bot

모험가의 길(MapleSpire) 디스코드 서버의 자동 감시 봇. GitHub Actions가 약 10분마다 `poll.py`를 실행합니다.

- **입장 인사**: #잡담-general(서버 시스템 채널)에 입장 메시지가 올라오면 디스코드 「손 흔들기」 버튼과 같은 기본 스티커로 답장합니다(스티커가 안 되면 👋 반응).
- **새 소식 알림**: 포럼(질문 · 버그 제보 · 건의 · 번역 오류)의 새 글 · 새 댓글(봇 · 서버 주인 제외)을 모아 #moderator-only에 서버 주인을 멘션해 알립니다.

설정
- 봇 토큰: 저장소 Secrets `DISCORD_BOT_TOKEN`(코드 · 로그에 나오지 않음).
- 상태(어디까지 봤는지): `state/state.json`, Actions 캐시로 실행 사이에 이어짐. 캐시가 없으면 첫 실행은 기준점만 기록하고 아무것도 보내지 않습니다.
- 대상 채널 · 스티커 목록: `poll.py` 맨 위 `FORUMS` · `NOTIFY_CHANNEL` · `WAVE_STICKERS`.
- 수동 실행: Actions 탭 → discord-poll → Run workflow. 로컬 시험: `DISCORD_BOT_TOKEN=... python poll.py --dry`(읽기만).
- `keepalive`: 공개 저장소의 예약 실행이 60일 활동 없음으로 꺼지지 않게 매달 다시 켭니다.
