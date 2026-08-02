# meMo

두 사람을 위한 Firebase 기반 PWA 채팅 앱이다. 별도 빌드 없이 정적 호스팅에서 실행한다.

## 주요 구성

- `index.html`: UI, Firebase Auth/Realtime Database/Storage 연동, 채팅·앨범·검색·버킷·보관함
- `app-core.js`: 검색 정규화, 앨범 날짜, 영상 용량 검증 등 테스트 가능한 순수 로직
- `firebase-messaging-sw.js`: FCM 백그라운드 알림과 중복 방지
- `manifest.json`: PWA 설치 정보
- `tests/app.test.mjs`: JavaScript 구문, DOM ID, 핵심 기능 배선 정적 검사
- `functions/`: 관리자 앨범 삭제·복구, 음성 메시지 생성, 7일 만료 정리
- `database.rules.json`, `storage.rules`: 두 계정 전용 서버 권한과 파일 크기 검증

## v3 개선

- 화면에 로드되지 않은 과거 메시지까지 페이지 단위 전체 검색
- 검색 결과 문맥 보기
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

## 검사

```bash
npm test
```

## Firebase 배포

운영 규칙을 먼저 백업한 뒤 실행한다.

```bash
npx firebase-tools@15.25.1 deploy --only database,storage --project memo-e366f
npx firebase-tools@15.25.1 deploy --only functions:deleteAlbumMedia,functions:restoreAlbumMedia,functions:createVoiceMessage,functions:purgeExpiredMedia,functions:cleanupOrphanVoiceUploads --project memo-e366f
```

기존 `sendPushOnMessage`는 별도 운영 자산이다. 함수 전체 배포는 이를 삭제 후보로 만들 수 있으므로 위 함수 목록을 유지한다. 음성 메시지 알림 문구가 필요하면 발송 서버에서 `type: audio`를 `🎙️ 음성 메시지`로 처리해야 한다.
