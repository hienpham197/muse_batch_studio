# Muse Batch Studio

[English](README.md) · **Tiếng Việt**

Tool web chạy trên máy bạn để tạo video AI hàng loạt: dán danh sách prompt, gắn nhân vật bằng ảnh tham chiếu `@tag`, chạy song song qua nhiều tài khoản, theo dõi trực tiếp, xem trước rồi mới tải MP4. Kèm **Flow Studio** để làm image-to-video bằng thẻ kéo-thả.

> **Hai chế độ**
> - `MUSE_ADAPTER=muse` tạo video **thật** trên [muse.ai](https://muse.ai) bằng Chrome đã đăng nhập (xem [Tạo video thật trên Muse](#tạo-video-thật-trên-muse)).
> - Adapter mặc định `mock` chỉ tạo video mẫu test pattern, không phải kết quả AI. Giao diện luôn gắn nhãn **MÔ PHỎNG** cho các video này.

> **Lưu ý.** Đây là dự án độc lập, không chính thức, không liên kết hay được bảo trợ bởi Meta hoặc Muse. Tự động hóa một web app qua trình duyệt có thể trái điều khoản sử dụng của dịch vụ đó. Chỉ dùng với tài khoản của chính bạn và tự chịu trách nhiệm.

## Tính năng

- **Nhập hàng loạt**: mỗi dòng một video (hoặc mỗi đoạn, hoặc cả văn bản là một prompt). Badge đếm trực tiếp số job sắp tạo.
- **Ảnh tham chiếu `@tag`**: gõ `@` để chọn ảnh trong kho. Tag lạ hiện màu đỏ; bấm vào để chọn một ảnh có sẵn trong kho và prompt được sửa theo.
- **Account Pool**: nhiều tài khoản, mỗi tài khoản có slot. Chỉ một dispatcher FIFO gán job, retry khi lỗi, xử lý timeout và rate limit, không bao giờ chạy trùng một job.
- **Dải chạy trực tiếp**: mọi job đang chạy luôn được ghim ở đầu trang, kèm thời gian đã chạy.
- **Xem trước rồi mới tải**, có tìm kiếm, lọc theo trạng thái và phân trang.
- **Tạo lại**: tạo job mới từ một job đã xong (cùng prompt, ảnh, độ dài, tỉ lệ); video cũ được giữ nguyên. Job gốc bị khóa trong lúc job tạo lại còn chờ hoặc chạy, nên không đẩy trùng vào hàng đợi.
- **Flow Studio**: thẻ image-to-video trên canvas kéo và zoom được, dùng chung hàng đợi.
- **An toàn mặc định**: credential mã hóa khi lưu, API và log không trả hay ghi thông tin nhạy cảm, server từ chối lắng nghe ngoài loopback nếu chưa có mã truy cập.

## Chạy thử

Yêu cầu: **Node.js 24 trở lên** (dùng `node:sqlite` có sẵn). ffmpeg không bắt buộc (dùng để tạo thumbnail với adapter `muse`).

```bash
git clone https://github.com/hienpham197/muse_batch_studio.git
cd muse_batch_studio
npm install

# Phát triển: web tại http://localhost:5173, API tại http://127.0.0.1:8787
npm run dev

# Chạy bản build: mở http://127.0.0.1:8787
npm run build
npm start
```

Lần đầu mở giao diện:

1. Bấm **Tài khoản** ở góc phải header, thêm một hoặc nhiều tài khoản vào Account Pool, bằng tài khoản + mật khẩu hoặc bằng [cookie](#đăng-nhập-bằng-cookie).
2. Bấm **+ Thêm ảnh tham chiếu**, chọn nhiều ảnh, sửa tag nếu cần rồi bấm **Lưu N ảnh vào kho**.
3. Dán danh sách prompt (mỗi dòng một video, gõ `@` để chọn ảnh). Prompt tự vào hàng đợi sau khoảng 2 giây.
4. Bấm **▶ Chạy hàng đợi**, theo dõi ở dải **Đang chạy trực tiếp**, bấm thumbnail để xem, bấm **Tải MP4**.

Với adapter `mock`, tài khoản nào cũng đăng nhập được, trừ mật khẩu (hoặc giá trị cookie) bắt đầu bằng `invalid`. Có thể thêm marker vào prompt để thử các tình huống lỗi:

| Marker | Hành vi |
|---|---|
| `[lỗi]` | Job luôn lỗi, dùng để thử retry rồi chuyển Thất bại |
| `[lỗi-lần-đầu]` | Lỗi ở lần chạy đầu, lần retry sau thành công |
| `[treo]` | Dừng báo tiến độ, dùng để thử timeout |
| `[giới-hạn]` | Báo rate limit một lần, dispatcher giảm nhịp rồi tự chạy tiếp |

## Tạo video thật trên Muse

Muse không có API công khai: khung chat đi qua WebSocket mã hóa do chính trang web xử lý. Vì vậy adapter `muse` ([server/src/adapters/muse-browser.ts](server/src/adapters/muse-browser.ts)) điều khiển một Chrome thật đã đăng nhập bằng Playwright, theo cách của dự án [Muse-Chat-MCP](https://github.com/duclm1x1/Muse-Chat-MCP) (MIT), nơi các selector được mượn. Mỗi job làm đúng các bước:

1. Mở chat mới (`/thread/new`).
2. Đính các ảnh tham chiếu của job, **đúng thứ tự**; tên file là tag (`gecko-than-lan-xanh.png`). Chỉ gửi khi đã thấy ảnh nằm trong khung soạn, nếu không thì job báo lỗi `REF_NOT_ATTACHED` thay vì gửi một video thiếu ảnh.
3. Gửi prompt **nguyên văn** (giữ xuống dòng, không bọc thêm lời mở đầu). Chỉ nối thêm ở cuối những gì Muse không có chỗ khai báo riêng: độ dài và tỉ lệ nếu prompt chưa nhắc tới, và thứ tự ảnh tham chiếu. Nếu khung soạn nhận thiếu quá 10% ký tự, job báo lỗi `PROMPT_NOT_TYPED` thay vì gửi một prompt bị cụt.
4. Chờ Muse trả video, tải file MP4 về, tạo thumbnail bằng ffmpeg nếu có.

```bash
# macOS / Linux
MUSE_ADAPTER=muse MUSE_HEADLESS=1 npm start

# Windows PowerShell
$env:MUSE_ADAPTER = "muse"; $env:MUSE_HEADLESS = "1"; npm start
```

**Cách đăng nhập** (chọn một):

| Cách | Cấu hình | Ghi chú |
|---|---|---|
| Cookie theo từng tài khoản (mặc định) | để trống `MUSE_PROFILE_DIR` và `MUSE_CDP` | App mở Chrome riêng và nạp cookie của từng tài khoản trong Account Pool vào từng browser context, nên nhiều tài khoản chạy song song được. Cookie phải đủ cookie HttpOnly (xuất bằng tiện ích quản lý cookie); chuỗi lấy từ `document.cookie` có thể bị Muse từ chối |
| Profile riêng của app | `MUSE_PROFILE_DIR=<thư mục>` (lần đầu để trống `MUSE_HEADLESS`) | Mở cửa sổ Chrome, đăng nhập Muse bằng tay một lần; phiên được giữ trong profile đó. Chỉ 1 tài khoản |
| Gắn vào Chrome đang chạy | `MUSE_CDP=http://127.0.0.1:9222` | Chrome phải mở bằng `--remote-debugging-port=9222 --user-data-dir=<thư mục riêng>`; Chrome 136 trở lên từ chối gắn vào profile mặc định. Chỉ 1 tài khoản |

Ở hai cách sau, phiên đăng nhập dùng chung nên Account Pool chỉ nhận 1 tài khoản và giá trị cookie nhập vào bị bỏ qua (nhập một cookie hợp lệ bất kỳ, ví dụ `chrome=1`, để tạo mục tài khoản).

**Giới hạn cần biết:**

- Các selector (khung soạn, nút dừng, tin nhắn) lấy từ Muse-Chat-MCP. Luồng một ảnh tham chiếu đã chạy được trên muse.ai thật, và các lần chạy 3 đến 6 ảnh cũng chạy được, nhưng selector có thể hỏng bất cứ khi nào Muse đổi giao diện. Khi đó job lỗi `MUSE_DRIVER_ERROR` hoặc `REF_NOT_ATTACHED`; đặt `MUSE_DEBUG=1` để lưu ảnh chụp màn hình vào `data/muse-debug/` (trước khi gửi, sau khi gửi và khi lỗi).
- Muse không báo phần trăm, nên giao diện hiện thanh chạy "Đang tạo…" thay vì một con số bịa.
- Muse nhận độ dài 5 hoặc 10 giây ghi trong prompt và khi thử đã trả đúng độ dài đó, nhưng quyết định cuối cùng là của Muse.
- Mỗi tab chạy một job tại một thời điểm; nên giữ 1 slot cho mỗi tài khoản.
- Mỗi job mở một chat mới, nên prompt kiểu "tiếp nối từ khung cuối của Video 1" không có video trước để nối. Muốn liền mạch giữa các cảnh, hãy lưu ảnh khung cuối vào kho và gắn bằng `@tag`.
- Prompt có nhiều nhân vật hoặc nhiều ảnh tham chiếu làm độ giống và độ bão hòa màu giảm. Prompt ngắn hơn và ít ảnh hơn mỗi shot (ví dụ shot 5 giây) giữ nhân vật sát ảnh tham chiếu hơn.

## Đăng nhập bằng cookie

Dùng khi nền tảng chỉ cho đăng nhập bằng phiên trình duyệt có sẵn. Trong **Tài khoản**, chọn **Cookie**, đặt tên gợi nhớ (tùy chọn) rồi dán cookie. Chấp nhận hai dạng:

- Chuỗi header `Cookie`: `ten1=giatri1; ten2=giatri2` (lấy ở F12, thẻ Network, chọn một request, mục Request Headers). Tiền tố `Cookie:` được tự bỏ.
- JSON xuất từ tiện ích trình duyệt: `[{"name": "...", "value": "..."}]`.

Giao diện báo số cookie nhận diện được (không hiển thị giá trị). Server kiểm tra lại: tối đa 32 KB và 100 cookie, tên đúng RFC 6265, từ chối ký tự xuống dòng và điều khiển.

- Cookie được chuẩn hóa rồi mã hóa AES-256-GCM như mật khẩu. Tên hiển thị là `<tên gợi nhớ> · <6 ký tự dấu vân tay>`; dấu vân tay là băm có khóa nên không suy ngược được cookie.
- Dán lại cùng một cookie (kể cả khác thứ tự) bị báo trùng.
- Adapter nhận `{ kind: 'cookie', label, cookie }`, trong đó `cookie` dùng nguyên làm header `Cookie`.
- Cookie hết hạn hoặc bị nền tảng từ chối thì tài khoản chuyển Offline kèm hướng dẫn. Cookie không tự làm mới được, nên cần xóa tài khoản rồi thêm lại bằng cookie mới.
- **Cookie là một phiên đăng nhập đang sống.** Cookie đã dán vào chat, issue, commit hay ảnh chụp màn hình thì coi như đã lộ. Hãy đăng xuất phiên đó trên nền tảng để vô hiệu hóa cookie.

## Cấu hình

Đọc từ biến môi trường, mẫu ở [.env.example](.env.example). Server không tự nạp `.env`: hãy export biến trong shell, hoặc chạy bằng `node --env-file=.env`.

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `HOST`, `PORT` | `127.0.0.1`, `8787` | Địa chỉ lắng nghe. Ngoài loopback thì bắt buộc có `MUSE_ACCESS_TOKEN` |
| `MUSE_ACCESS_TOKEN` | trống | Bật màn hình đăng nhập cho chủ sở hữu workspace |
| `MUSE_DATA_DIR` | `./data` | SQLite, ảnh, video |
| `MUSE_KEY_DIR` | `%APPDATA%\muse-batch-manager` hoặc `~/.config/muse-batch-manager` | Khóa mã hóa credential, phải nằm ngoài `MUSE_DATA_DIR` |
| `MUSE_MASTER_KEY` | trống | Khóa 32 byte base64, ưu tiên hơn file khóa |
| `MUSE_ADAPTER` | `mock` | `muse` (video thật) hoặc `mock` (mô phỏng) |
| `MUSE_PROFILE_DIR`, `MUSE_CDP` | trống | Cách đăng nhập của adapter `muse` (xem phần trên) |
| `MUSE_CHANNEL`, `MUSE_HEADLESS` | `chrome`, trống | Trình duyệt (`chrome` hoặc `msedge`); đặt `MUSE_HEADLESS=1` để chạy ngầm, không hiện cửa sổ |
| `MUSE_PLATFORM_URL` | `https://muse.ai/` | Địa chỉ gốc của nền tảng |
| `MUSE_MAX_WAIT_MS`, `MUSE_IDLE_GRACE_MS` | 30 phút, 2 phút | Thời gian chờ tối đa một video; thời gian chờ thêm khi Muse đã ngừng trả lời mà chưa có video |
| `MUSE_DEBUG` | trống | Đặt `1` để lưu ảnh chụp màn hình Muse vào `data/muse-debug` |
| `MUSE_DEV_ROUTES` | trống | Đặt `1` để bật route điều khiển session mô phỏng (chỉ dùng cho test) |

Số luồng, retry (N), timeout (X) và slot mỗi tài khoản chỉnh ngay trên giao diện. Giá trị mặc định: 3 luồng, N = 2, X = 15 phút, 1 slot.

## Cách hệ thống chạy job

- **Chỉ dispatcher mới được gán job.** Mỗi lượt lấy job `Chờ` cũ nhất (FIFO), chọn tài khoản `enabled` + Online còn slot và ít việc nhất, kiểm tra sức khỏe phiên ngay trước khi gán, rồi chuyển job sang `Đang chạy`.
- **Số luồng hiệu dụng** = `min(số luồng cấu hình, tổng slot của các tài khoản Online)`. UI hiển thị cả hai số khi chúng khác nhau.
- **Job lỗi**: tự retry tối đa N lần với độ trễ tăng dần, hết lượt mới `Thất bại`, kèm mã lỗi gốc và diễn giải tiếng Việt.
- **Job treo**: quá X phút không có tiến độ thì abort, giải phóng slot, đánh dấu timeout và xếp lại hàng chờ (tính vào số lần retry).
- **Tài khoản mất kết nối, bị tắt hoặc bị xóa**: job đang chạy quay về `Chờ`, giữ nguyên vị trí FIFO và không tốn lượt retry. Mỗi lượt chạy có `runId` riêng, callback của lượt cũ bị bỏ qua nên không có job chạy trùng.
- **Rate limit** từ nền tảng: dispatcher tạm dừng gán job (cooldown tăng dần, tối đa 2 phút), không tốn lượt retry.
- **Dừng tất cả**: job đang chạy chuyển `Đã dừng`, job chờ giữ nguyên, không tự chạy lại.
- **Khởi động lại server**: job đang `Đang chạy` quay về `Chờ`, dispatcher ở trạng thái dừng cho tới khi bạn bấm chạy.
- **Tự dừng khi hết việc**: khi không còn job chờ hay đang chạy, dispatcher tắt. Thêm job mới lúc đang chạy thì được nhận tự động.

## Cấu trúc

```text
shared/   Kiểu dữ liệu, hằng số mặc định, tách prompt, nhận diện @tag, gợi ý tag, phân tích cookie
server/   Fastify + SQLite: Account Pool, dispatcher, kho ảnh, Studio, API, adapter
web/      React 19 + Vite + Tailwind CSS v4 (giao diện tiếng Việt)
e2e/      Test trình duyệt bằng Playwright (Python)
```

Mô hình lập lịch nằm ở [server/src/dispatcher.ts](server/src/dispatcher.ts) và [server/src/accounts.ts](server/src/accounts.ts). Bảng màu là các token ngữ nghĩa trong [web/src/index.css](web/src/index.css) (sáng và tối theo hệ điều hành). Một số comment trong mã trích các mục ("Mục 2.5") của đặc tả nội bộ ban đầu, tài liệu đó không được công bố.

## Gắn nền tảng khác

Cài đặt interface `PlatformAdapter` trong [server/src/adapters/types.ts](server/src/adapters/types.ts):

| Hàm | Việc cần làm |
|---|---|
| `login(credentials)` | Đăng nhập qua kênh chính thức của nền tảng, trả về session. Ném `AuthError` nếu bị từ chối |
| `health(session)` | Trả `healthy`, `expired` hoặc `unreachable` kèm lý do |
| `refresh(session)` | Làm mới phiên khi có thể |
| `generate(session, spec, hooks)` | Tạo video, gọi `hooks.onProgress` chỉ khi có tiến độ **thật** (nếu không, đặt `reportsProgress = false`), tải kết quả về file tạm và trả đường dẫn video + thumbnail. Ném `WorkerError` với `kind` phù hợp (`transient`, `permanent`, `rate-limit`, `session-lost`) |
| `close(session)` | Hủy phiên |

Sau đó đăng ký adapter trong `createAdapter` ở [server/src/core.ts](server/src/core.ts). `spec.refImages` đã chứa đường dẫn file ảnh của từng `@tag`, được resolve từ lúc tạo job; adapter không tự đọc lại tag từ prompt. Nếu nền tảng có API key chính thức, nên dùng API đó thay cho phiên trình duyệt: pool, dispatcher và luồng giữ nguyên.

## API nội bộ

Tất cả dưới `/api`, trả JSON, lỗi có dạng `{ "error": { "code", "message", "details" } }` với `message` tiếng Việt.

| Nhóm | Endpoint |
|---|---|
| Account | `GET/POST /accounts`, `PATCH/DELETE /accounts/:id`, `POST /accounts/:id/health` |
| Kho ảnh | `POST /refs/upload`, `POST /refs/commit`, `GET /refs`, `GET/DELETE /refs/:tag` |
| Cấu hình | `GET/PUT /settings`, `PUT /settings/concurrency` |
| Hàng đợi | `POST /queue/enqueue`, `/queue/process`, `/queue/stop`, `/queue/clear-finished` |
| Job | `GET /jobs`, `POST /jobs/:id/retry`, `POST /jobs/:id/regenerate`, `DELETE /jobs/:id`, `GET /jobs/:id/video`, `GET /jobs/:id/thumbnail` |
| Studio | `GET/POST /studio/cards`, `PATCH/DELETE /studio/cards/:id`, `POST /studio/generate-all` |
| Tổng quan | `GET /state` |

Upload ảnh chia hai bước (`upload` rồi `commit`) để người dùng sửa tag trước khi lưu.

## Bảo mật

| Mối đe dọa | Cách xử lý |
|---|---|
| Lộ credential trong DB hoặc backup | AES-256-GCM, khóa tách khỏi thư mục dữ liệu, `identifier` chỉ lưu dạng băm có khóa và bản che |
| Lộ credential qua UI, log, API | Không endpoint nào trả credential; log không ghi body và query; ô nhập bị xóa ngay khi gửi |
| Trang web lạ gọi API của bạn (CSRF, DNS rebinding) | Kiểm tra `Host` và `Origin`, cookie `HttpOnly` + `SameSite=Strict` |
| Truy cập trái phép | Mặc định chỉ lắng nghe loopback; ngoài loopback bắt buộc có mã truy cập; khóa tạm khi đoán sai 5 lần/phút |
| File upload độc hại | Giải mã thật bằng `sharp` ở server, chỉ nhận PNG, JPG, WebP; SVG và file giả đuôi bị từ chối; tên file không bao giờ dùng làm đường dẫn |
| Cookie bị lộ | Mã hóa khi lưu, ô nhập bị che và xóa ngay khi gửi, không hiển thị lại, không có trong log và phản hồi lỗi |
| Xóa nhầm tài khoản | API yêu cầu `confirm=true`, UI có hộp xác nhận |

Chưa làm: rate limit toàn cục cho API (tool dành cho một chủ sở hữu), TLS (đặt sau reverse proxy nếu mở ra ngoài máy), xoay khóa mã hóa tự động.

**Nếu bạn fork repo này, tuyệt đối không commit** `data/`, `.env`, cookie hay khóa mã hóa. Các mục này đã nằm trong [.gitignore](.gitignore).

## Kiểm thử

```bash
npm test            # 75 test: unit (shared) + tích hợp API, dispatcher và adapter Muse (server)
npm run typecheck
```

Adapter Muse được test với một Muse giả chạy cục bộ, có cùng các thuộc tính DOM mà adapter dùng. Test kiểm tra luồng điều khiển, không chứng minh selector khớp với trang thật.

Phần giao diện kiểm tra trên trình duyệt thật bằng bốn script Playwright trong [e2e/](e2e/): `ui_acceptance.py` (37 kiểm tra), `ui_cookie.py` (10 kiểm tra đăng nhập bằng cookie), `ui_attach.py` (chọn ảnh có sẵn trong kho cho tag đang thiếu) và `ui_extra.py` (9 kiểm tra: slot, cấu hình N/X, dải ghim, tắt tài khoản giữa chừng, lỗi + retry, player không bị reset khi làm mới 2 giây). Mỗi script cần một server mới với dữ liệu trống:

```bash
# cần: pip install playwright và trình duyệt Microsoft Edge
MUSE_DATA_DIR=/tmp/muse-e2e MUSE_KEY_DIR=/tmp/muse-e2e-keys MUSE_MOCK_JOB_SECONDS=9 MUSE_MOCK_FAIL_RATE=0 npm start
MUSE_URL=http://localhost:8787 python e2e/ui_acceptance.py   # dừng server, xóa dữ liệu, chạy lại server rồi mới chạy ui_extra.py
```

## Quyết định thiết kế

- **"Dán là chạy luôn"** chỉ tự thêm job vào hàng đợi, không tự bấm chạy. Bạn vẫn bấm **▶ Chạy hàng đợi**.
- **Timeout** xếp job lại hàng chờ và tính một lần retry; hết N lần thì chuyển `Thất bại` với mã `JOB_TIMEOUT`.
- **"Dọn mục đã xong"** chỉ ẩn job khỏi danh sách, video vẫn được giữ. Xóa bằng nút `×` trên dòng thì xóa luôn file.
- **Job của Studio** nằm chung hàng đợi và dải trực tiếp nhưng không hiện trong danh sách Hàng đợi, vì đã có trên thẻ của chúng.
- **Ảnh dùng chung cho batch** được gắn sau các ảnh `@tag`.
- **Không tìm thấy tag khi tạo job** thì cả đợt bị từ chối, không tạo job nào, thay vì chạy thiếu ảnh.

## Giấy phép

Phát hành theo **[PolyForm Noncommercial License 1.0.0](LICENSE)** (giấy phép phi thương mại).

- **Được phép:** dùng cá nhân, học tập, nghiên cứu, dự án sở thích, và dùng trong tổ chức giáo dục, từ thiện hoặc phi thương mại khác. Bạn được sửa và chia sẻ cho các mục đích này, miễn là giữ nguyên văn bản giấy phép và dòng `Required Notice`.
- **Không được phép:** thương mại hóa. Gồm bán lại, cung cấp như sản phẩm hoặc dịch vụ có thu phí, đưa vào sản phẩm thương mại, hay dùng để kiếm tiền (ví dụ tạo video để bán). Muốn dùng thương mại, hãy liên hệ tác giả để xin giấy phép riêng.
- Đây là giấy phép *source-available*, không phải giấy phép mã nguồn mở theo định nghĩa của OSI. Các thư viện bên thứ ba giữ giấy phép riêng của chúng.

## Ghi công

- [Muse-Chat-MCP](https://github.com/duclm1x1/Muse-Chat-MCP) (MIT): nghiên cứu cách điều khiển web app Muse.
- Xây dựng bằng Fastify, React, Vite, Tailwind CSS, Playwright và sharp.
