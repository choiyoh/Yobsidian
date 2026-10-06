import { useEffect } from "react";
import type { Settings } from "@/app/settings";

interface Props {
  settings: Settings;
  onChange(settings: Settings): void;
  onClose(): void;
}

/** Preferences. Every change applies and is saved immediately. */
export function SettingsDialog({ settings, onChange, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => onChange({ ...settings, [key]: value });
  const text = (key: "attachmentFolder" | "templateFolder" | "dailyFolder" | "dailyFormat" | "dailyTemplate", label: string, hint: string, placeholder: string) => (
    <label className="setting">
      <span>{label}</span>
      <input value={settings[key]} placeholder={placeholder} spellCheck={false} onChange={(e) => set(key, e.target.value)} />
      <span className="hint">{hint}</span>
    </label>
  );

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="설정">
        <h2>설정</h2>
        <p className="muted">이 기기에만 저장돼요. 비워 둔 칸은 볼트의 옵시디언 설정(<code>.obsidian</code>)을 따르고, 그 폴더는 읽기만 해요.</p>

        <h3>화면</h3>
        <label className="setting">
          <span>테마</span>
          <select value={settings.theme} onChange={(e) => set("theme", e.target.value as Settings["theme"])}>
            <option value="system">시스템 설정 따르기</option>
            <option value="light">밝게</option>
            <option value="dark">어둡게</option>
          </select>
        </label>
        <label className="setting">
          <span>편집기 글자 크기 ({settings.fontSize}px)</span>
          <input type="range" min={12} max={26} value={settings.fontSize} onChange={(e) => set("fontSize", Number(e.target.value))} />
        </label>

        <h3>첨부 파일</h3>
        {text("attachmentFolder", "첨부 파일 폴더", "이미지를 붙여넣거나 끌어다 놓으면 여기에 저장돼요. “./images”처럼 쓰면 노트 옆 폴더.", "볼트 설정 따르기 (기본: 볼트 최상위)")}

        <h3>일일 노트</h3>
        {text("dailyFolder", "폴더", "일일 노트를 만들 폴더", "볼트 최상위")}
        {text("dailyFormat", "파일 이름 형식", "YYYY, MM, DD, ddd 같은 표기. “YYYY/MM/YYYY-MM-DD”처럼 하위 폴더도 가능해요.", "YYYY-MM-DD")}
        {text("dailyTemplate", "템플릿 노트", "새 일일 노트에 채울 템플릿 (예: Templates/Daily)", "없음")}

        <h3>템플릿</h3>
        {text("templateFolder", "템플릿 폴더", "“템플릿 삽입”이 이 폴더의 노트를 보여줘요. {{title}} {{date}} {{time}} 사용 가능", "Templates")}

        <div className="dialog-actions">
          <button onClick={onClose}>닫기</button>
        </div>
      </div>
    </div>
  );
}
