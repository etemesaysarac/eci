type TileStatus = "active" | "locked" | "beta";

type Tile = {
  group: string;
  title: string;
  status: TileStatus;
};

const tiles: Tile[] = [
  { group: "Çekirdek", title: "Kurulum Sihirbazı", status: "active" },
  { group: "Çekirdek", title: "Bağlantılar", status: "active" },
  { group: "Çekirdek", title: "İşler & Loglar", status: "active" },

  { group: "Operasyon", title: "Siparişler", status: "locked" },
  { group: "Operasyon", title: "Kargo / Sevkiyat", status: "locked" },
  { group: "Operasyon", title: "Fatura / E-Belge", status: "locked" },
  { group: "Operasyon", title: "Mesajlar / Soru-Cevap", status: "locked" },

  { group: "Katalog", title: "Ürünler", status: "locked" },
  { group: "Katalog", title: "Stok & Fiyat", status: "locked" },
  { group: "Katalog", title: "Kategori / Attribute Eşleme", status: "locked" },

  { group: "Analiz", title: "Rekabet / BuyBox", status: "beta" },
  { group: "AI", title: "AI Ürün Araştırma", status: "beta" },

  { group: "Yönetim", title: "Kullanıcılar & Yetkiler", status: "active" },
  { group: "Yönetim", title: "Paket & Lisans", status: "active" },
  { group: "Yönetim", title: "Ayarlar", status: "active" }
];

function badge(status: TileStatus) {
  const base: React.CSSProperties = {
    padding: "4px 8px",
    borderRadius: 999,
    fontSize: 12,
    border: "1px solid #333",
    opacity: 0.85
  };
  const text = status === "active" ? "ACTIVE" : status === "locked" ? "LOCKED" : "BETA";
  return <span style={base}>{text}</span>;
}

export default function Page() {
  const groups = Array.from(new Set(tiles.map(t => t.group)));

  return (
    <main style={{ fontFamily: "system-ui", padding: 24, maxWidth: 1100, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 8 }}>ECI Dashboard</h1>
      <p style={{ marginTop: 0, opacity: 0.8 }}>
        Sprint1: Tile iskeleti + modül yol haritası (ikonlar/temalar sonra).
      </p>

      {groups.map(g => (
        <section key={g} style={{ marginTop: 24 }}>
          <h2 style={{ fontSize: 18, marginBottom: 12 }}>{g}</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 12 }}>
            {tiles.filter(t => t.group === g).map(t => (
              <div
                key={t.title}
                style={{
                  border: "1px solid #333",
                  borderRadius: 12,
                  padding: 14,
                  minHeight: 92,
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  opacity: t.status === "locked" ? 0.6 : 1
                }}
              >
                <div style={{ fontSize: 16, fontWeight: 600 }}>{t.title}</div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  {badge(t.status)}
                  <span style={{ fontSize: 12, opacity: 0.8 }}>v0.0.1</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </main>
  );
}
