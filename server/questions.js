/** Sample question bank — add more anytime. Format: { text, a, b } */
export const QUESTIONS = [
  { text: "信邊樣多啲？", a: "風水", b: "星座" },
  { text: "寧可失去邊樣？", a: "手機一日", b: "睡眠一日" },
  { text: "約會遲到，你通常？", a: "提早到等", b: "卡時間到" },
  { text: "週末你更想？", a: "出街食飯", b: "屋企躺平" },
  { text: "睇戲你偏好？", a: "喜劇", b: "恐怖片" },
  { text: "旅行你會？", a: "計劃詳細", b: "即興亂闖" },
  { text: "傾計時你比較？", a: "聽人講", b: "自己講" },
  { text: "壓力大時你會？", a: "狂食嘢", b: "狂瞓覺" },
  { text: "買嘢你傾向？", a: "貨比三家", b: "一眼睇中即買" },
  { text: "朋友約你，你多數？", a: "秒回 OK", b: "先睇心情" },
  { text: "你更相信？", a: "感覺", b: "數據" },
  { text: "派對上你通常？", a: "識人傾偈", b: "黐住熟友" },
  { text: "訊息已讀不回，你覺得？", a: "好正常", b: "有啲介意" },
  { text: "你比較鍾意？", a: "貓", b: "狗" },
  { text: "熱天你寧願？", a: "開冷氣", b: "吹風扇" },
  { text: "做錯事你會？", a: "即刻道歉", b: "先觀察反應" },
  { text: "你更怕？", a: "孤獨", b: "尷尬" },
  { text: "選餐廳你會？", a: "睇評分", b: "睇氣氛" },
  { text: "送禮你傾向？", a: "實用為主", b: "驚喜為主" },
  { text: "你覺得自己比較？", a: "理性", b: "感性" },
];

export function pickRandomQuestion(excludeTexts = []) {
  const pool = QUESTIONS.filter((q) => !excludeTexts.includes(q.text));
  const source = pool.length > 0 ? pool : QUESTIONS;
  return source[Math.floor(Math.random() * source.length)];
}
