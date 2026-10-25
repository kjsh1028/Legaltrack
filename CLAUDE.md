# Legaltrack 작업 규칙

## 배포 방식
- 수정 사항은 **main 브랜치에 바로 커밋하고 push**한다. 별도 브랜치나 PR을 만들지 않는다.
  (저장소 소유자가 직접 요청한 방식)
- push 전에 `git pull origin main`으로 최신 상태를 받아 충돌을 막는다.
- 커밋 메시지는 무엇을 왜 바꿨는지 한국어로 간단히 적는다.

## 파일 구성
- `index.html` — 앱 본체 (HTML/CSS/JS 한 파일)
- `index.html`을 바꾸면 **반드시** `index.html` 안의 `APP_VERSION`(및 `<meta name="app-version">`)을 올린다. 앱은 이 번호를 GitHub의 최신 파일과 비교해 "새 버전" 배너를 띄우므로, 안 올리면 아이폰 등에서 업데이트가 반영되지 않는다.
- `sw.js` — 서비스 워커 (오프라인 캐시). `index.html`을 바꾸면 `sw.js`의 `CACHE_NAME` 날짜 버전(예: legaltrack-vYYYYMMDDNN)도 올려서 기존 사용자에게 새 버전이 반영되게 한다.
- `legaltrack-data.json` — 데이터 파일
