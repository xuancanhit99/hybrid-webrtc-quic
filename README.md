# Nguyên mẫu truy cập từ xa Hybrid WebRTC + QUIC

Sản phẩm này là bản triển khai tham chiếu có thể chạy được, không có phần phụ thuộc lúc chạy, dành cho kiến trúc hybrid:

- mặt phẳng điều khiển Node.js với token định danh có chữ ký, đăng ký thiết bị và cấp quyền phiên;
- máy chủ báo hiệu WebSocket RFC 6455 thực, chỉ chuyển tiếp thông điệp WebRTC SDP/ICE;
- bản demo WebRTC trên trình duyệt với chụp màn hình, video từ xa, DataChannel tin cậy và gửi tệp nhỏ;
- cấu hình coturn để dự phòng qua STUN/TURN bằng thông tin xác thực HMAC tạm thời;
- nền tảng đóng khung nhị phân có phiên bản và truyền tệp có thể tiếp tục, độc lập với lớp vận chuyển;
- ranh giới adapter QUIC cùng tác nhân host Windows bằng Python có thể chạy được.

Sản phẩm chủ ý không có phần phụ thuộc npm khi chạy. Chỉ cần Node 20+.

## Kiến trúc

```text
Browser / Python Windows host agent
        | HTTPS: auth, devices, sessions, one-time signaling ticket
        v
Node control plane ----- WebSocket signaling ----- second peer
        |                                          |
        +-------------- SDP + ICE only ------------+
                                                   |
                 WebRTC media + DataChannel <------+
                   direct ICE, TURN fallback

Native file layer: HYB1 framing -> Transport interface -> QUIC adapter
```

Mặt phẳng điều khiển không bao giờ nhận khung hình màn hình hoặc byte của tệp. Mỗi vé signaling chỉ dùng được một lần và hết hạn sau 30 giây. Token phiên được ký bằng HMAC và có thời hạn. Trong nguyên mẫu này, một người dùng phải sở hữu cả hai thiết bị; quyền truy cập giữa các tài khoản phải được triển khai bằng quyền chia sẻ/ACL rõ ràng thay vì nới lỏng bước kiểm tra đó.

## Chạy cục bộ

```powershell
cd remote-products/hybrid-webrtc-quic
npm start
```

Mở <http://127.0.0.1:8787>. `SESSION_SECRET` được tạo trong bộ nhớ cho môi trường phát triển loopback và thay đổi sau mỗi lần khởi động lại. Máy chủ từ chối khóa bí mật ký quá ngắn và yêu cầu khai báo rõ `ENROLLMENT_TOKEN` khi lắng nghe ngoài loopback hoặc khi `NODE_ENV=production`.

### Chạy toàn bộ stack máy chủ bằng Docker

Đặt ba khóa bí mật ngẫu nhiên độc lập, sau đó khởi động mặt phẳng điều khiển và coturn cùng nhau:

```powershell
$env:SESSION_SECRET = node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
$env:ENROLLMENT_TOKEN = node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
$env:TURN_SECRET = node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
docker compose up --build
```

Mặc định, mặt phẳng điều khiển chỉ được công bố trên loopback tại `127.0.0.1:8787`. Đặt `CONTROL_PORT` để đổi cổng trên máy host. Để truy cập từ xa, hãy kết thúc HTTPS tại proxy ngược (reverse proxy) đáng tin cậy và chủ động thay đổi ánh xạ cổng; không để điểm cuối HTTP dành cho phát triển truy cập trực tiếp từ Internet. Image sử dụng `node:22-alpine`, chạy bằng người dùng không đặc quyền `node` và có kiểm tra sức khỏe nội bộ tại `/healthz`.

Chạy kiểm thử nhanh toàn stack có khả năng tự dọn dẹp (tập lệnh tạo khóa bí mật tạm thời, loại bỏ việc công bố cổng host qua cấu hình ghi đè Compose, chờ cả hai kiểm tra sức khỏe, gọi `/healthz` bên trong container điều khiển rồi luôn xóa Compose project cô lập):

```powershell
.\scripts\runtime-smoke.ps1
```

Trên Linux/macOS, dùng `./scripts/runtime-smoke.sh`.

Host Windows trong [`agent/README.md`](agent/README.md) bổ sung chụp màn hình native, truyền tệp qua DataChannel có giới hạn và điều khiển bàn phím/chuột cần người dùng chấp thuận, sử dụng Python 3.13, `aiortc`, `mss` và `pynput`.

### Đóng gói release candidate

```powershell
.\agent\scripts\build-agent.ps1 -Clean
.\agent\scripts\verify-release.ps1
.\scripts\package-control-plane.ps1
```

Artifact được ghi vào `agent\release\` và `release\`. Workflow `.github/workflows/release.yml` chạy lại test Node/Python, build và xác minh EXE Windows, tạo checksum/metadata giấy phép rồi upload hai bundle khi chạy thủ công hoặc khi push tag `hybrid-v*`. Workflow chủ ý không tạo GitHub Release, không push image và không publish repository.

Để triển khai ổn định, hãy sao chép các giá trị trong `.env.example` vào môi trường của bạn (máy chủ không tự động nạp `.env`):

```powershell
$env:SESSION_SECRET = '<at-least-32-random-characters>'
$env:ENROLLMENT_TOKEN = '<private-enrollment-token>'
$env:HOST = '0.0.0.0'
$env:PUBLIC_ORIGIN = 'https://remote.example.com'
npm start
```

Khi đã cấu hình `ENROLLMENT_TOKEN`, hãy gửi giá trị này qua `X-Enrollment-Token` đến `POST /api/v1/auth/enroll`. Giao diện demo chủ ý chỉ phục vụ phát triển trên loopback và không thu thập khóa bí mật quản trị này.

### Demo WebRTC với hai trình duyệt

1. Đăng ký một định danh phục vụ phát triển.
2. Đăng ký hai thiết bị trình duyệt, ví dụ `Controller` và `Host`.
3. Chọn `Controller` làm nguồn, dán hoặc chọn `Host` làm đích rồi tạo một phiên.
4. Trong tab đầu tiên, kết nối dịch vụ báo hiệu bằng thiết bị nguồn.
5. Mở tab thứ hai, dán ID `ses_...`, chọn thiết bị đích trong danh sách thả xuống của thiết bị nguồn (khi kết nối, danh sách này có nghĩa là "thiết bị của tab hiện tại"), nhấp **Use session**, rồi kết nối.
6. Từ một trong hai đầu ngang hàng đã kết nối, nhấp **Share this screen**. Đầu còn lại sẽ nhận media track WebRTC.
7. Dùng **Send data ping** hoặc **Send a small file** để thử DataChannel tin cậy.

Nút gửi tệp trên trình duyệt chủ ý chỉ là bản minh họa trải nghiệm cho tệp nhỏ (8 MiB). Các khối DataChannel dạng nhị phân mang offset uint64 rõ ràng, được giới hạn bằng cơ chế backpressure và chỉ được chấp nhận đúng thứ tự; phía nhận xác minh kích thước và SHA-256 trước khi cung cấp liên kết tải xuống. Giao thức native trong `src/protocol/` hỗ trợ bản kê rõ ràng, các khối dữ liệu, checksum, xác minh SHA-256 cuối cùng và thay thế lớp vận chuyển.

## Dự phòng qua TURN

Tạo một khóa bí mật; không dùng giá trị mặc định được commit vào mã nguồn:

```powershell
$env:TURN_SECRET = node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
docker compose up -d coturn
$env:TURN_URL = 'turn:127.0.0.1:3478'
$env:TURN_USERNAME = 'dynamic'
$env:TURN_SECRET = '<same value used by compose>'
npm start
```

Mặc định, Compose stack ánh xạ các cổng host của coturn vào `127.0.0.1`, phù hợp với thiết lập cục bộ an toàn của mặt phẳng điều khiển. Chỉ đặt `TURN_BIND=0.0.0.0` (hoặc giao diện mạng riêng/công khai cụ thể) khi chủ động công khai lưu lượng relay, đồng thời cập nhật `TURN_URL` thành địa chỉ truy cập từ bên ngoài. Tiến trình coturn lắng nghe trên mọi giao diện mạng của container (`TURN_LISTENING_IP=0.0.0.0`); hãy phân biệt thiết lập này với ánh xạ trên host. Mở UDP/TCP 3478 và UDP 49160-49200 trên relay host. Môi trường production cũng cần `external-ip` công khai, chứng chỉ TLS, DNS, giới hạn tốc độ và giám sát năng lực theo khu vực. API tạo thông tin xác thực coturn REST có hiệu lực một giờ; API không gửi `TURN_SECRET` đến đầu ngang hàng.

## API

| Endpoint | Mục đích |
| --- | --- |
| `GET /healthz` | Trạng thái hoạt động và bộ đếm đối tượng trong bộ nhớ |
| `POST /api/v1/auth/enroll` | Đăng ký định danh cho phát triển/bootstrap |
| `GET /api/v1/me` | Xác minh định danh bằng bearer token |
| `GET/POST /api/v1/devices` | Liệt kê/đăng ký thiết bị |
| `POST /api/v1/sessions` | Cấp quyền cho phiên giữa hai thiết bị |
| `GET /api/v1/config` | Cấu hình ICE cho client với thông tin xác thực TURN tạm thời |
| `POST /api/v1/signal-tickets` | Cấp WebSocket ticket dùng một lần, có thời hạn 30 giây |
| `GET /signal?ticket=...` | Signaling WebSocket SDP/ICE |

Trạng thái chủ ý được lưu trong bộ nhớ để dễ tái hiện cục bộ. Mô hình được tách biệt trong `src/control/store.mjs`; bản triển khai thực tế nên triển khai cùng các phương thức trên PostgreSQL và lưu trạng thái hiện diện ngắn hạn trong Redis/NATS.

## Ranh giới QUIC native

Node 22 không cung cấp API máy chủ QUIC tích hợp ổn định, vì vậy việc giả vờ rằng đường truyền native đã hoàn chỉnh sẽ làm nguyên mẫu kém hữu ích hơn. Thay vào đó, `src/protocol/file-transfer.mjs` cung cấp:

- frame `HYB1` có phiên bản và phát hiện hỏng dữ liệu bằng CRC32;
- xác thực bản kê và quy tắc basename an toàn;
- các khối tệp được đánh số và kiểm tra thứ tự nghiêm ngặt;
- xác minh SHA-256 cho toàn bộ tệp;
- `MemoryTransport` dùng trong kiểm thử tích hợp;
- `QuicTransport`, hợp đồng adapter dành cho agent native dùng Rust/quinn, Go/quic-go hoặc MsQuic.

Bản triển khai native tiếp theo nên ánh xạ mỗi tệp vào một QUIC stream tin cậy, dùng stream tin cậy có thứ tự cho điều khiển/input và QUIC DATAGRAM cho dữ liệu đo đạc chấp nhận mất gói. WebRTC vẫn là lớp vận chuyển cho trình duyệt.

## Kiểm thử

```powershell
npm test
npm run test:unit
npm run test:smoke
py -3.13 -m unittest discover -s agent/tests -v
```

Các bộ kiểm thử bao phủ ranh giới hết hạn/giả mạo token, cấp quyền thiết bị/phiên, lỗi hỏng dữ liệu trong đóng khung nhị phân, tính toàn vẹn của tệp nhiều khối, thay thế lớp vận chuyển, lời gọi kiểm tra sức khỏe/API, vé signaling dùng một lần, chuyển tiếp thông điệp WebSocket giữa hai đầu ngang hàng, điều khiển trên trình duyệt, sự chấp thuận/giới hạn tốc độ cho input, signaling Python/Node, DataChannel aiortc thực, khung hình màn hình được chụp và cấu hình coturn/container.

## Các phần còn thiếu trước khi dùng trong production

Đây là sản phẩm tham chiếu có chức năng, chưa phải bản phát hành điều khiển từ xa không cần giám sát. Trước khi đưa vào production, cần bổ sung PostgreSQL, OIDC/MFA, bằng chứng khóa thiết bị rõ ràng, quyền chia sẻ/ACL giữa người dùng, lời nhắc phê duyệt, lưu nhật ký kiểm toán bền vững, gia cố HTTPS/proxy ngược, thu hồi phiên, cập nhật agent Windows có chữ ký/ký mã, xử lý UAC/secure desktop, giới hạn tốc độ, số liệu giám sát, định tuyến TURN đa khu vực, quét mã độc/hạn ngạch cho tệp nhận được và adapter QUIC bằng Rust/Go đã được kiểm định. Remote input vẫn là tính năng phải chủ động bật và yêu cầu tệp chấp thuận cục bộ; agent không bao giờ cố vượt qua UAC hoặc chụp secure desktop.

## Ghi chú về giấy phép và phần phụ thuộc

Mã nguồn trong thư mục này tuân theo giấy phép MIT của repository cha. Mặt phẳng điều khiển chỉ dùng thành phần tích hợp sẵn của Node.js; agent Python tùy chọn phụ thuộc `aiortc`, `mss`, `numpy` và `pynput`, còn coturn là dịch vụ bên ngoài có giấy phép riêng từ dự án gốc. Hãy rà soát toàn bộ giấy phép bắc cầu trước khi phân phối sản phẩm được xây dựng từ bản tham chiếu này.
