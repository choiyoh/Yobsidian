const WEEKDAYS = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];

const TOKEN = /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|A|a/g;

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/**
 * Format a date with Moment-style tokens, the notation Obsidian's daily-note and
 * template settings use: `YYYY-MM-DD`, `YYYY/MM/YYYY-MM-DD ddd`, `HH:mm`, `[text]`.
 * Month and weekday names are Korean.
 */
export function formatDate(date: Date, format: string): string {
  const h = date.getHours();
  return format.replace(TOKEN, (token, literal?: string) => {
    if (literal !== undefined) return literal;
    switch (token) {
      case "YYYY":
        return pad(date.getFullYear(), 4);
      case "YY":
        return pad(date.getFullYear() % 100);
      case "MMMM":
      case "MMM":
        return `${date.getMonth() + 1}월`;
      case "MM":
        return pad(date.getMonth() + 1);
      case "M":
        return String(date.getMonth() + 1);
      case "DD":
        return pad(date.getDate());
      case "D":
        return String(date.getDate());
      case "dddd":
        return WEEKDAYS[date.getDay()];
      case "ddd":
      case "dd":
        return WEEKDAYS[date.getDay()][0];
      case "d":
        return String(date.getDay());
      case "HH":
        return pad(h);
      case "H":
        return String(h);
      case "hh":
        return pad(h % 12 || 12);
      case "h":
        return String(h % 12 || 12);
      case "mm":
        return pad(date.getMinutes());
      case "m":
        return String(date.getMinutes());
      case "ss":
        return pad(date.getSeconds());
      case "s":
        return String(date.getSeconds());
      case "A":
      case "a":
        return h < 12 ? "오전" : "오후";
      default:
        return token;
    }
  });
}
