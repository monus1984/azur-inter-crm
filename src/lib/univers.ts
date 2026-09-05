import type { UniversOffre } from "../types/database";

export function deviserUnivers(offre: string): UniversOffre {
  const l = offre.toLowerCase();
  if (l.includes("mix") || l.includes("community") || l.includes("sms")) return "MOBILE";
  if (l.includes("topup") || l.includes("flybox") || l.includes("easybox") || l.includes("fibre")) return "INTERNET";
  if (l.includes("office") || l.includes("ict")) return "ICT";
  return "AUTRES";
}
