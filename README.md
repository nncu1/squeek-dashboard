# squeek-dash

Explorer cho **Squeekchain**: xem toàn bộ Squeek NFT, bấm vào từng con để xem owner và lịch sử, theo dõi merge đang diễn ra, bảng xếp hạng level và bảng xếp hạng ví theo power.

Giao diện tiếng Anh để chia sẻ với cộng đồng. Giao diện sáng: nền xám nhạt, thẻ trắng, vàng Squeekchain cho dot-matrix, xanh cho link.

Dùng cho bản triển khai Squeekchain ngày 24/10/2026 (collection "Squeek - Sealed" `0x0514…67B0`, vault stake `0x9011…20eb`).

## Chức năng

| Tab | Có gì |
|---|---|
| **1 overview** | Block height dạng dot-matrix, bánh xe và livestream của Squeektoshi, kỷ lục 7 ngày, biểu đồ merge theo giờ (48h), số Squeek còn sống, số ví, NFT power đang stake, merge 24h, SQK đang lưu hành (phần stake trong vault và phần nằm trong ví), bảng Squeek theo level (số lượng, số trong vault, power mỗi con, cooldown) |
| **2 squeeks** | Lưới mọi Squeek còn sống kèm ảnh. Lọc theo ID/owner, level, trạng thái (ready / cooldown / max), nơi giữ (vault / ví), sắp xếp theo level, power, ID, thứ tự mint. Ô vuông vàng = đang nằm trong vault |
| **Click 1 NFT** | Panel chi tiết: ảnh, traits, chủ (người gửi vào vault nếu đang stake), level, power và hạng, còn bao nhiêu block Squeekchain mới merge được, lịch sử mint/transfer/deposit/withdraw/merge kèm link tx |
| **3 leaderboards** | Xếp hạng ví theo power đang stake, tổng power, số Squeek, số Squeek trong vault, level cao nhất, số lần merge, số cặp đang merge được |
| **4 merges** | Feed merge mới nhất (ai, con nào nuốt con nào, lên level mấy) và feed gửi/rút khỏi vault |
| **5 wallet** | Dán địa chỉ, xem toàn bộ Squeek, power stake, hạng, cặp merge được, phần thưởng SQK từ API (claimable, đã stake, SQK power, kiếm được từng ngày trong 7 ngày) và hoạt động |
| **6 ecosystem** | Danh sách project xây trên Squeekchain, dạng lưới hoặc bảng, tìm kiếm và lọc theo category. Thêm project bằng cách sửa `public/ecosystem.json` (logo để trong `public/eco/`), không cần sửa code |

Link chia sẻ được: `#nft/123`, `#wallet/0x…`, `#ecosystem`… Phím `1`–`6` chuyển tab, `Esc` đóng panel.

## Chạy

Cần Node.js 20.6 trở lên.

```powershell
npm install --omit=dev      # chỉ cần viem; bỏ --omit=dev nếu muốn chạy test
copy .env.example .env      # tùy chọn: điền RPC riêng (Alchemy/Infura) cho ổn định
npm start
```

Mở `http://127.0.0.1:8787`.

- **Lần chạy đầu** server đọc toàn bộ lịch sử collection từ block 11.985.210, rồi đọc level của mọi Squeek qua Multicall3. Thường mất 1–3 phút với RPC tốt. Thanh trên cùng hiện % tiến độ. Nếu `data/state.json` là của bản triển khai cũ, server tự bỏ nó và index lại từ đầu.
- Sau đó cứ 30 giây kiểm tra block mới, 2 phút đọc lại level. Dữ liệu lưu ở `data/state.json`, tắt bật lại sẽ chạy tiếp từ chỗ cũ.
- Ảnh và metadata lấy từ API Squeekchain phía server (`/v1/squeeks/{id}`). Nếu API lỗi thì tự đọc `tokenURI` trên chain. Ảnh được cache vĩnh viễn ở `data/meta/<collection>/`, mỗi collection một thư mục nên ảnh cũ không bị lẫn.
- Ảnh gốc của Squeek là SVG 1568×1568 với hàng nghìn chấm, trình duyệt vẽ 40 cái một lúc sẽ giật. Vì vậy server vẽ sẵn mỗi con thành PNG 288px (`@resvg/resvg-js`, khoảng 20ms/ảnh), lưu ở `data/thumb/<collection>/`; lưới NFT và trang ví dùng PNG này, chỉ panel chi tiết mới hiện SVG gốc.
- Khi đã index xong, server tự tải trước ảnh của toàn bộ Squeek ở chế độ nền (level cao trước), nhường ưu tiên cho trang đang mở. Lần đầu mất khoảng 20 phút, sau đó mọi trang đều mở tức thì. Tắt bằng `WARM_IMAGES=0`.
- Muốn mở cho máy khác trong mạng LAN thì đặt `HOST=0.0.0.0`.

## Tự cập nhật

- Server kiểm tra block mới mỗi 30 giây (chỉ lấy block đã đủ 12 xác nhận, nên chậm hơn thực tế ~2,5–3 phút) và đọc lại level mỗi khi có sự kiện mới, chậm nhất 2 phút một lần.
- Trang web tự làm mới mỗi 20 giây ở mọi tab, **tại chỗ**: giữ nguyên trang đang xem, vị trí cuộn, và không tải lại ảnh; chỉ thẻ/dòng nào có số thay đổi mới được vẽ lại. Tab bị ẩn thì tạm dừng, quay lại là cập nhật ngay.

## Deploy

Xem [DEPLOY.md](DEPLOY.md): VPS + Docker + HTTPS tự động (khuyên dùng), VPS không Docker, hoặc chia sẻ nhanh qua Cloudflare Tunnel.

## Cách lấy dữ liệu

| Dữ liệu | Nguồn |
|---|---|
| Owner, mint, transfer, gửi/rút vault, burn | Event `Transfer` của collection. Chuyển vào vault = deposit (chủ vẫn tính là người gửi), từ vault ra = withdraw |
| Merge (ai merge, survivor, donor, level, block merge tiếp) | Log merge của chính collection, nằm cùng tx với lần burn donor. Contract chưa verify nên log được đọc theo hình dạng: từ chứa ID donor, ID survivor đứng cạnh, rồi level và next merge height |
| Level | `level(id)` trên collection cho mọi Squeek, đọc gộp qua Multicall3 |
| Power mỗi level, cooldown, tổng NFT power, SQK supply/stake | API `/v1/economy/state` (mặc định giống API nếu API lỗi) |
| Block height Squeekchain, độ khó | API `/v1/core`, dự phòng `SqueekCore.state()` trên chain |
| Trạng thái bánh xe | API `/v1/status` |
| Kỷ lục của hamster | API `/v1/measurement/stats?range=7d` (cache 5 phút) |
| Phần thưởng SQK của một ví | API `/v1/accounts/{address}` |
| Trạng thái livestream | `media.squeekchain.com/live/current.json`, file website dùng, không có trong docs |

Các request tới API gửi kèm ETag (`If-None-Match`), nên nếu dữ liệu không đổi thì chỉ nhận về 304. Có nhiều RPC chạy song song: viem tự xếp hạng theo độ trễ mỗi 30 giây, RPC chết bị bỏ qua ngay chứ không retry.

Chỉ index tới block đã có 12 xác nhận, giống cách docs Squeekchain làm. "Ready to merge" = chưa max level và next merge height ≤ block height Squeekchain hiện tại. Chỉ Squeek nằm trong vault mới có NFT power tính thưởng.

## Test

```powershell
npm install
npm test
```

Test dựng một Hardhat node local (RPC đầu tiên cố tình để chết để kiểm tra fallback), một mock API Squeekchain có ETag, với contract mock cùng ABI thật, mô phỏng 486 lần mint, gửi vào vault, merge lên tới L6 (cả trong ví lẫn trong vault), transfer, rút khỏi vault. Sau đó chạy server thật lên trên và kiểm tra 25 điều: tổng số khớp chain, level khớp từng merge, power stake chỉ tính Squeek trong vault, mọi merge được giải mã, trạng thái cooldown, lọc/sắp xếp, lịch sử NFT, bảng xếp hạng, fallback `tokenURI`, ảnh SVG bị sandbox, ecosystem, resume từ file state.

`node test/run.mjs --keep` để giữ bản giả lập chạy ở `http://127.0.0.1:8790` mà xem thử giao diện.

## Lưu ý

- Đây là testnet: SQK và Squeek không có giá trị. Contract Squeekchain có thể được nâng cấp hoặc deploy lại; khi đó đổi địa chỉ trong `.env` (`NFT_ADDRESS`, `VAULT_ADDRESS`, `INDEX_FROM_BLOCK`, `API_BASE`); server tự index lại.
- Ảnh NFT là dữ liệu không tin cậy: chỉ hiển thị qua `<img>` và được phục vụ với CSP `sandbox`, không chèn SVG vào trang.
- Reorg sâu hơn 12 block (rất hiếm) có thể làm lệch dữ liệu; xóa `data/state.json` để index lại từ đầu.
