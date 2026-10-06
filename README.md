# Yobsidian

개인 전용 옵시디언 호환 노트 앱. 웹, 윈도우, 맥에서 같은 화면으로 쓰고 노트는 구글 드라이브로 동기화한다.
설계는 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 참고.

## 지금 되는 것

- 마크다운 편집: 라이브 프리뷰(커서 줄만 원문 표시) / 소스 / 읽기 모드, YAML 프런트매터, 체크박스, 코드 블록, 이미지·노트 임베드
- `[[위키링크]]`: 클릭하면 열기(없으면 새 노트), `[[` 자동완성, `[[노트#제목]]`, `[[노트|별칭]]`
- 백링크·나가는 링크·태그·개요 패널, 태그 목록, 빠른 전환(`Ctrl/Cmd+O`), 뒤로/앞으로(`Alt+←/→`)
- 전체 검색(`Ctrl/Cmd+Shift+F`): `"정확한 문구"`, `-제외`, `path:폴더`, `file:이름`, `tag:태그`, `content:본문`
- 속성 패널: 프런트매터를 폼으로 편집(텍스트·목록·숫자·체크박스·날짜), 모르는 형식은 그대로 보존
- 이미지·파일을 붙여넣거나 끌어다 놓으면 볼트에 저장하고 `![[이미지.png]]`를 삽입 (폴더는 옵시디언 `attachmentFolderPath` 또는 설정을 따름)
- 일일 노트(`YYYY-MM-DD` 등 형식·폴더·템플릿 설정)와 템플릿 삽입(`{{title}}` `{{date}}` `{{time}}`, `{{date:YYYY/MM}}`)
- 명령 팔레트(`Ctrl/Cmd+P`)와 설정(`Ctrl/Cmd+,`): 테마, 글자 크기, 첨부·일일 노트·템플릿 폴더
- 파일 탐색기: 새 노트·폴더, 이름 바꾸기(링크 자동 갱신), 삭제(`.trash`로 이동)
- 자동 저장. 웹에서는 브라우저(IndexedDB)에 볼트를 보관
- 데스크톱: 디스크의 폴더를 볼트로 열기 (기존 옵시디언 볼트 그대로, `.obsidian`은 읽기만)
- 구글 드라이브 동기화: 드라이브 폴더를 볼트와 양방향 동기화, 충돌은 덮어쓰지 않고 `(충돌 …)` 파일로 보존, 상태 표시줄에서 상태 확인.
  **먼저 [구글 연결 설정 가이드](docs/GOOGLE_SETUP.md)대로 OAuth 클라이언트 ID를 만들어야 해요.**

## 개발

필요한 것: Node.js 22+, (데스크톱 빌드 시) Rust stable과 [Tauri 사전 요구사항](https://tauri.app/start/prerequisites/).

```bash
npm install
npm run dev            # 웹: http://localhost:1420
npm run desktop:dev    # 데스크톱 창으로 실행 (Tauri)
npm test               # 단위 테스트
npm run build          # 웹 정적 빌드 → dist/
npm run desktop:build  # 현재 OS용 설치 파일 → src-tauri/target/release/bundle/
```

윈도우·맥 설치 파일은 PR마다 GitHub Actions(CI)가 빌드해서 아티팩트로 올린다.
