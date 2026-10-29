# Deploy squeek-dash lên internet

squeek-dash là **một tiến trình Node chạy liên tục**: vừa index chain, vừa phục vụ trang web, và cần một thư mục `data/` lưu lâu dài (index, metadata, ảnh thu nhỏ). Vì vậy nó cần một máy chạy 24/7, **không** chạy được trên Vercel/Netlify/Cloudflare Pages (các nền tảng đó chỉ chạy hàm ngắn hạn, không có ổ đĩa giữ lại).

| Cách | Hợp với | Chi phí |
|---|---|---|
| **A. VPS + Docker** (khuyên dùng) | trang công khai có tên miền, HTTPS tự động | VPS ~5 USD/tháng + tên miền |
| **B. VPS không Docker** (Node + systemd + Caddy) | thích quản lý thẳng trên máy | như A |
| **C. Cloudflare Tunnel từ máy của bạn** | chia sẻ nhanh, thử nghiệm | miễn phí, máy phải luôn bật |

Cấu hình tối thiểu: 1 vCPU, 1 GB RAM, 10 GB ổ đĩa, Ubuntu 22.04 hoặc 24.04.

---

## A. VPS + Docker (khuyên dùng)

Docker chạy 2 container: `dash` (squeek-dash) và `caddy` (tự xin chứng chỉ HTTPS từ Let's Encrypt và chuyển tiếp vào `dash`). Cổng 8787 không mở ra ngoài, chỉ Caddy gọi được.

### 1. Trỏ tên miền về VPS

Ở nơi quản lý DNS, tạo bản ghi:

```
Loại: A    Tên: squeek (hoặc @)    Giá trị: <IP của VPS>
```

Nếu dùng Cloudflare DNS, để **DNS only** (đám mây xám) trong lần đầu để Caddy xin được chứng chỉ. Đợi vài phút rồi kiểm tra: `ping squeek.tenmien.com` phải ra đúng IP VPS.

### 2. Cài Docker trên VPS

```bash
ssh root@<IP>
curl -fsSL https://get.docker.com | sh
ufw allow 22 && ufw allow 80 && ufw allow 443 && ufw --force enable
```

### 3. Đưa code lên VPS

Từ máy của bạn (PowerShell):

```powershell
scp squeek-dash.zip root@<IP>:/opt/
```

Trên VPS:

```bash
cd /opt && apt-get install -y unzip && unzip squeek-dash.zip && cd squeek-dash
```

(Nếu code nằm trên GitHub: `git clone https://github.com/<you>/squeek-dash.git /opt/squeek-dash`.)

### 4. Tạo file `.env`

```bash
cp .env.example .env
nano .env
```

Sửa ít nhất 2 dòng:

```ini
DOMAIN=squeek.tenmien.com
# RPC riêng đặt đầu tiên cho ổn định; public RPC để dự phòng
RPC_URL=https://eth-sepolia.g.alchemy.com/v2/<KEY>,https://ethereum-sepolia-rpc.publicnode.com,https://11155111.rpc.thirdweb.com
```

Một key Alchemy hoặc Infura miễn phí là đủ. Chạy 24/7 chỉ bằng RPC công cộng thì dễ bị giới hạn `eth_getLogs`.

### 5. Chạy

```bash
docker compose up -d --build
docker compose logs -f dash      # xem tiến độ, Ctrl+C để thoát (không tắt server)
```

Mở `https://squeek.tenmien.com`.

- **Lần đầu**: index toàn bộ lịch sử chain mất vài phút (thanh trên cùng hiện %). Sau đó server tự tải trước ảnh của mọi Squeek trong khoảng 20 phút; log hiện `images cached` là xong.
- `docker compose ps` hiện `healthy` khi index đã sẵn sàng (kiểm tra qua `/healthz`).
- Container tự khởi động lại khi lỗi hoặc khi VPS reboot.

### Mang dữ liệu đã index ở máy bạn lên (bỏ qua bước sync lần đầu)

```bash
# trên VPS, sau khi đã chép thư mục data/ của máy bạn vào /opt/squeek-dash/data
docker compose cp ./data/. dash:/app/data/
docker compose exec -u root dash chown -R node:node /app/data
docker compose restart dash
```

### Cập nhật phiên bản mới

Chép đè file mới vào `/opt/squeek-dash` (hoặc `git pull`), rồi:

```bash
docker compose up -d --build
```

Dữ liệu trong volume `dash-data` giữ nguyên qua các lần build.

### Lệnh hay dùng

```bash
docker compose logs -f dash          # log
docker compose restart dash          # khởi động lại
docker compose down                  # tắt (dữ liệu vẫn còn)
docker volume rm squeek-dash_dash-data   # xoá index để sync lại từ đầu (khi Squeekchain deploy lại contract)
```

---

## B. VPS không Docker

```bash
# Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs unzip
# user riêng, không có quyền root
useradd --system --create-home --shell /usr/sbin/nologin squeek
mkdir -p /opt/squeek-dash && cd /opt && unzip squeek-dash.zip   # hoặc git clone
cd /opt/squeek-dash && npm ci --omit=dev
cp .env.example .env && nano .env          # RPC_URL như mục A.4 (DOMAIN không cần ở đây)
mkdir -p data && chown -R squeek:squeek /opt/squeek-dash

# chạy như dịch vụ
cp deploy/squeek-dash.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now squeek-dash
journalctl -u squeek-dash -f               # log
```

HTTPS bằng Caddy:

```bash
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy
cat > /etc/caddy/Caddyfile <<'CADDY'
squeek.tenmien.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8787
}
CADDY
systemctl reload caddy
ufw allow 22 && ufw allow 80 && ufw allow 443 && ufw --force enable
```

Cập nhật: chép đè file, `npm ci --omit=dev`, `systemctl restart squeek-dash`.

---

## C. Chia sẻ nhanh từ máy của bạn (Cloudflare Tunnel)

Không cần VPS hay tên miền. Trang chỉ online khi máy bạn bật và `npm start` đang chạy.

1. Cài `cloudflared`: `winget install --id Cloudflare.cloudflared`
2. Trong `.env` của squeek-dash đặt `TRUST_PROXY=1`, rồi `npm start`.
3. Ở cửa sổ khác:

```powershell
cloudflared tunnel --url http://localhost:8787
```

Nó in ra một link dạng `https://xxxx.trycloudflare.com` để gửi cho người khác. Link đổi mỗi lần chạy; muốn link cố định với tên miền riêng thì tạo "named tunnel" trong Cloudflare Zero Trust.

---

## Bảo mật khi mở công khai

- Trang chỉ **đọc** dữ liệu testnet công khai, không có ví, không có private key. Key RPC trong `.env` chỉ nằm ở server, trình duyệt không thấy.
- Mỗi người truy cập bị giới hạn `RATE_LIMIT` request/giây (mặc định 30, cho phép bùng lên gấp 4). Quá mức nhận `429`.
- Ảnh và metadata chỉ phục vụ cho token đã mint, nên không ai ép được server gọi API Squeekchain với ID tùy ý.
- Ảnh SVG của NFT được trả về với CSP `sandbox`, không chạy được script trên trang.
- Đừng mở cổng 8787 trực tiếp ra internet; luôn để Caddy (hoặc tunnel) đứng trước, và đặt `TRUST_PROXY=1` khi có proxy đứng trước.

## Kiểm tra nhanh khi có lỗi

| Hiện tượng | Xem gì |
|---|---|
| Trang báo "The indexer is starting" lâu | `docker compose logs dash`: có `sync failed` không? Thường là RPC chặn `eth_getLogs`, thêm RPC riêng vào `RPC_URL` |
| Caddy không xin được HTTPS | Tên miền đã trỏ đúng IP chưa, cổng 80/443 đã mở chưa, Cloudflare có đang bật đám mây cam không |
| Ảnh NFT trống | API Squeekchain tạm lỗi; server tự đọc `tokenURI` trên chain, đợi vài phút |
| Hết dung lượng | `docker system prune` để dọn image cũ; dữ liệu của dashboard chỉ vài trăm MB |
