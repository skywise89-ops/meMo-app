# meMo

두 사람을 위한 Firebase 기반 PWA 채팅 앱이다. 별도 빌드 없이 정적 호스팅에서 실행한다.

## 주요 구성

- `index.html`: UI, Firebase Auth/Realtime Database/Storage 연동, 채팅·앨범·검색·버킷·보관함
- `app-core.js`: 검색 정규화, 앨범 날짜, 영상 용량 검증 등 테스트 가능한 순수 로직
- `firebase-messaging-sw.js`: FCM 백그라운드 알림과 중복 방지
- `manifest.json`: PWA 설치 정보
- `tests/app.test.mjs`: JavaScript 구문, DOM ID, 핵심 기능 배선 정적 검사

## v3 개선

- 화면에 로드되지 않은 과거 메시지까지 페이지 단위 전체 검색
- 검색 결과 문맥 보기
- 데스크탑 앨범 썸네일 크기 제한
- 월·유형 필터와 날짜별 앨범 그룹
- FCM 자동 알림과 수동 알림의 중복 표시 방지
- 데스크탑 메시지 오른쪽 클릭·더보기 메뉴
- 영상 5MB 제한과 업로드 전 일괄 검증
- 신규 앨범 항목에서 원본 대화 문맥 보기

## 검사

```bash
npm test
```

Firebase Database Rules, Storage Rules, FCM 발송 서버 코드는 별도 운영 자산이다. 배포 전 현재 운영 설정과 함께 검증해야 한다.
