# meMo

두 사람을 위한 Firebase 기반 PWA 채팅 앱이다. 별도 빌드 없이 정적 호스팅에서 실행한다.

## 주요 구성

- `index.html`: UI, Firebase Auth/Realtime Database/Storage 연동, 채팅·앨범·좋아요·검색·버킷·보관함
- `app-core.js`: 검색 정규화, 메시지 페이지 병합, 앨범 날짜, 영상 용량 검증 등 테스트 가능한 순수 로직
- `firebase-messaging-sw.js`: FCM 백그라운드 알림과 중복 방지
- `manifest.json`: PWA 설치 정보
- `tests/app.test.mjs`: JavaScript 구문, DOM ID, 핵심 기능 배선 정적 검사
- `functions/`: 관리자 앨범 삭제·복구, 음성 메시지 생성, 7일 만료 정리
- `database.rules.json`, `storage.rules`: 두 계정 전용 서버 권한과 파일 크기 검증

## v3 개선

- 화면에 로드되지 않은 과거 메시지까지 페이지 단위 전체 검색
- 검색 결과에서 원본 채팅 위치로 이동
- 데스크탑 앨범 썸네일 크기 제한
- 월·유형 필터와 날짜별 앨범 그룹
- FCM 자동 알림과 수동 알림의 중복 표시 방지
- 데스크탑 메시지 오른쪽 클릭·더보기 메뉴
- 영상 5MB 제한과 업로드 전 일괄 검증
- 신규 앨범 항목에서 원본 대화 문맥 보기

## v4 개선

- `fromkevinjung@gmail.com` 전용 앨범 삭제와 7일 휴지통 복구
- 과거 `messageKey` 없는 미디어도 URL로 원본 메시지 탐색
- 60초·2MiB 제한 음성 메시지와 Safari MP4/AAC·WebM/Opus 대응
- 음성 파일 업로드 완료 후 7일 만료, 15분 주기 서버 정리
- 고아 음성 업로드 8일 후 정리
- RTDB·Storage Rules로 삭제 권한과 업로드 크기 서버 검증

## v4.1 개선

- 비공식 브라우저 번역 호출을 인증된 Cloud Translation v3 NMT callable Function으로 교체
- 번역 표시 설정을 계정별로 저장하고 발신 번역 생성과 분리
- 번역 실패 시 원문 전송과 사용자 안내
- 연속 메시지의 번역·저장 순서를 보장하는 전송 큐
- 신규 보관함 항목에 번역문 보존
- 과거 번역 누락 메시지는 변경하거나 재번역하지 않음

## v4.1.1 개선

- 정상 네트워크에서는 기존처럼 원문과 번역문을 함께 저장
- 클라이언트 번역 요청이 서버에 도달하지 못하면 신규 메시지만 RTDB trigger로 번역 보충
- 첫 네트워크 실패 후 60초간 client callable을 건너뛰어 연속 전송 지연 방지
- fallback 처리 중·실패 상태를 채팅에 표시
- 과거 `translation:null` 메시지는 조회하거나 변경하지 않음

## v4.2 개선

- 사진·영상 개인 좋아요(즐겨찾기). 라이트박스(확대 보기) 좌상단 ♡ 버튼으로 토글
- 좋아요는 계정별로 `favorites/$name`에 저장되며 상대방에게는 보이지 않음
- 앨범 툴바의 `♥ 좋아요` 토글로 좋아요한 항목만 모아 보기(월·유형 필터와 함께 적용)
- 앨범 썸네일 좌상단에 좋아요 표시 배지
- 관리자 앨범 삭제 시 좋아요를 함께 정리하고, 휴지통 복구 시 원래대로 되돌림
- RTDB Rules로 본인 계정 경로만 쓰기 허용, 값은 타임스탬프(number)만 저장

## v4.2.1 개선

- 검색 결과를 누르면 별도 문맥 팝업 대신 원본 채팅 위치로 직접 이동
- 화면에 없는 과거 메시지는 해당 `messageKey` 전후 30개씩 직접 조회해 빠르게 표시
- 과거 위치에서 위·아래 양방향 메시지 로드와 `최신` 버튼 제공
- 검색 대상 메시지를 일시 강조하고, 앨범의 `대화 보기`도 같은 이동 경로 사용
- 메시지 페이지 병합 시 key 정렬·중복 제거, 날짜 구분선 재정렬

## v4.2.2 개선

- Firebase push key를 locale 정렬이 아닌 RTDB ASCII 순서로 정렬해 검색 위치의 시간순 보장
- 과거 채팅 창에 최신 50개 cache를 붙이지 않아 날짜가 현재로 건너뛰는 현상 제거
- 최신 message key를 별도 조회해 과거 모드·최신 복귀 상태를 정확히 판정
- 실제 운영 push key 형태(대문자·소문자·`_`)로 정렬 회귀 테스트 추가

## v4.2.3 개선

- `app-core.js`와 Service Worker URL에 앱 버전을 붙여 이전 JavaScript cache 재사용 차단
- Service Worker 등록에 `updateViaCache: none`을 적용하고 시작 시 업데이트 확인
- 앱 문서와 `app-core.js` 요청을 `cache: no-store`로 가져와 GitHub Pages 10분 cache 영향 제거

## v4.2.4 개선

- HTML shell과 `app-core.js` 버전을 별도로 대조해 혼합 버전 실행 차단
- 구 `index.html`이 새 core를 불러오면 `memo-version` URL로 자동 재접속해 최신 shell 강제 로드
- 화면의 앱 버전만 바뀌고 검색 이동 로직은 구버전으로 남는 상태 방지

## 검사

```bash
npm test
```

## Firebase 배포

운영 규칙을 먼저 백업한 뒤 실행한다.

```bash
npx firebase-tools@15.25.1 deploy --only database,storage --project memo-e366f
npx firebase-tools@15.25.1 deploy --only functions:translateText,functions:fillMissingTranslation,functions:deleteAlbumMedia,functions:restoreAlbumMedia,functions:createVoiceMessage,functions:purgeExpiredMedia,functions:cleanupOrphanVoiceUploads --project memo-e366f
```

기존 `sendPushOnMessage`는 별도 운영 자산이다. 함수 전체 배포는 이를 삭제 후보로 만들 수 있으므로 위 함수 목록을 유지한다. 음성 메시지 알림 문구가 필요하면 발송 서버에서 `type: audio`를 `🎙️ 음성 메시지`로 처리해야 한다.
