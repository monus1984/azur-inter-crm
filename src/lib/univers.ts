import type { UniversOffre } from "../types/database";

export function deviserUnivers(offre: string): UniversOffre {
  const l = (offre || "").toLowerCase().trim();

  if (
    l.includes("fibre") || l.includes("ftth") ||
    l.includes("flybox") || l.includes("easybox") ||
    l.includes("4g") || l.includes("topup") ||
    l.includes("internet") || l.includes("tdd") || l.includes("fdd")
  ) return "INTERNET";

  if (
    l.includes("mix") || l.includes("community") ||
    l.includes("sms") || l.includes("mobile") ||
    l.includes("flex") || l.includes("start lite") ||
    l.includes("api sms") || l.includes("bew")
  ) return "MOBILE";

  if (
    l.includes("office") || l.includes("ict") ||
    l.includes("baas") || l.includes("mssp") ||
    l.includes("edr") || l.includes("youscribe") ||
    l.includes("guard") || l.includes("mos") || l.includes("microsoc") ||
    l.includes("doro") || l.includes("logicom") || l.includes("fanvil") || l.includes("yealink")
  ) return "ICT";

  if (
    l.includes("fixe") || l.includes("voix") || l.includes("fixnet")
  ) return "FIXE";

  return "AUTRES";
}
