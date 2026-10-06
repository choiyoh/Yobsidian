import { MemoryAdapter } from "./memory-adapter";

/** Notes a brand-new web vault starts with, so there is something to click through. */
export const SAMPLE_FILES: Record<string, string> = {
  "Welcome.md": `---
tags: [welcome]
aliases: [Start, 시작]
---
# Yobsidian에 오신 걸 환영해요

옵시디언과 같은 규칙으로 동작하는 노트 앱이에요. 아래를 직접 해보세요.

- **라이브 프리뷰**: 커서가 없는 줄은 서식이 적용돼 보이고, 커서를 올리면 마크다운 원문이 나타나요.
- **위키링크**: [[Links|여기를 눌러]] 노트를 열어 보세요. [[아직 없는 노트]]를 누르면 새로 만들어져요.
- \`[[\`를 입력하면 노트 이름이 자동완성돼요. \`[[Roadmap#\`처럼 \`#\`를 붙이면 제목을 골라요.
- 오른쪽 패널에서 **백링크**와 **개요**를 볼 수 있어요. 빠른 전환은 \`Ctrl/Cmd + O\`.
- 할 일: 
  - [x] 노트 열기
  - [ ] 체크박스 눌러 보기

#yobsidian #welcome
`,
  "Roadmap.md": `---
tags: [plan]
---
# Roadmap

## 단계
1. 설계와 프로젝트 뼈대
2. 마크다운 편집기, [[Links|위키링크]], 백링크, 태그
3. [[Graph view]]
4. 구글 드라이브 싱크와 배포

## 메모
처음으로 돌아가기: [[Welcome]]
`,
  "Concepts/Links.md": `# Links

옵시디언 문법을 그대로 써요: \`[[노트]]\`, \`[[노트|별칭]]\`, \`[[노트#제목]]\`, \`![[Roadmap#단계]]\`.

![[Roadmap#단계]]

돌아가기: [[Welcome]] #concepts/links
`,
  "Concepts/Graph view.md": `# Graph view

노트 사이의 링크를 노드 그래프로 보여줘요(3단계). 링크: [[Links]], [[Roadmap]]
`,
  "Daily/2026-10-06.md": `# 2026-10-06

- 프로젝트 시작 → [[Roadmap]]
`,
};

/**
 * A small in-memory vault for tests and demos.
 */
export function createSampleVault(): MemoryAdapter {
  return new MemoryAdapter("Sample Vault", { ...SAMPLE_FILES, ".obsidian/app.json": `{ "attachmentFolderPath": "attachments" }\n` });
}
