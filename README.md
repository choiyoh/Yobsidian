# Yobsidian

개인 전용 옵시디언 호환 노트 앱. 웹, 윈도우, 맥에서 같은 화면으로 쓰고 노트는 구글 드라이브로 동기화한다.
설계는 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 참고.

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
