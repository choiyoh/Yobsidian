import { MemoryAdapter } from "./memory-adapter";

/**
 * A small in-memory vault so the app has something to show before real
 * storage (local folder, Google Drive) is wired up.
 */
export function createSampleVault(): MemoryAdapter {
  return new MemoryAdapter("Sample Vault", {
    "Welcome.md": `# Yobsidian에 오신 걸 환영해요

이 화면은 앱 뼈대예요. 왼쪽 파일 목록은 **저장소 추상화**(VaultAdapter)를 통해 읽은 것이고,
지금은 메모리 안의 샘플 볼트를 보여주고 있어요.

- 편집기와 [[Links|위키링크]]는 다음 단계에서 만들어요.
- 그래프 뷰는 [[Graph view]] 노트를 참고하세요.
- 구글 드라이브 연동은 [[Roadmap]]에 있어요.

#yobsidian #welcome
`,
    "Roadmap.md": `---
tags: [plan]
---
# Roadmap

1. 설계와 프로젝트 뼈대
2. 마크다운 편집기, [[Links|위키링크]], 백링크, 태그
3. [[Graph view]]
4. 구글 드라이브 싱크와 배포
`,
    "Concepts/Links.md": `# Links

옵시디언 문법을 그대로 써요: \`[[노트]]\`, \`[[노트|별칭]]\`, \`[[노트#제목]]\`, \`![[이미지.png]]\`.

돌아가기: [[Welcome]]
`,
    "Concepts/Graph view.md": `# Graph view

노트 사이의 링크를 노드 그래프로 보여줘요. 링크: [[Links]], [[Roadmap]]
`,
    "Daily/2026-10-06.md": `# 2026-10-06

- 프로젝트 시작 → [[Roadmap]]
`,
    ".obsidian/app.json": `{ "attachmentFolderPath": "attachments" }\n`,
  });
}
