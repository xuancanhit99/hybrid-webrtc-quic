# Tác nhân host Windows

Thư mục này chứa tác nhân native tùy chọn cho sản phẩm hybrid. Agent được thiết kế cho Windows 10/11 và Python 3.13, nhưng các kiểm thử giao thức/chính sách cũng chạy được trên Linux/macOS mà không cần cơ chế nền để chụp màn hình desktop.

Agent kết nối với mặt phẳng điều khiển Node qua HTTPS/WebSocket, trả lời đề nghị WebRTC từ trình duyệt bằng `aiortc`, chụp desktop của host bằng `mss` và cung cấp DataChannel có giới hạn cho chức năng điều khiển và truyền tệp.

## Cài đặt

```powershell
cd remote-products/hybrid-webrtc-quic/agent
py -3.13 -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.lock
```

`aiortc`, `mss`, `numpy` và `pynput` là các thư viện nạp tùy chọn trong kiểm thử đơn vị, nhưng bắt buộc đối với môi trường chạy host hoàn chỉnh. Tệp khóa cố định phiên bản các phần phụ thuộc trực tiếp; hãy luôn rà soát giấy phép bắc cầu trước khi phân phối lại.

## Bản phát hành Windows độc lập

Build và xác minh tệp `.exe` một-file bằng PyInstaller:

```powershell
cd remote-products/hybrid-webrtc-quic/agent
.\scripts\build-agent.ps1 -Clean
.\scripts\verify-release.ps1
```

Artifact nằm tại `release\HybridHostAgent.exe`, kèm `SHA256SUMS.txt`, README, giấy phép và metadata phụ thuộc. Máy Windows đích không cần cài Python. Ứng dụng giữ cửa sổ console để lỗi cấu hình hoặc chấp thuận luôn hiển thị rõ ràng.

Để onboarding, sao chép `config.example.json` thành `config.json`, chỉnh endpoint/phiên/thiết bị rồi chạy `launch-agent.ps1`. Nếu chưa có `config.json`, launcher tự tạo bản an toàn và dừng để người dùng review. Tham số CLI ghi đè giá trị JSON; không commit bearer token, enrollment token, `config.json` hay tệp chấp thuận.

## Sự chấp thuận và an toàn thao tác đầu vào

Chia sẻ màn hình và truyền tệp không cấp quyền thao tác đầu vào của hệ điều hành. Tính năng giả lập thao tác đầu vào mặc định bị tắt.

- `--allow-input` cho phép host chấp nhận điều khiển đầu vào nhưng vẫn yêu cầu tệp chấp thuận cục bộ.
- `--consent-file C:\path\to\consent.txt` phải chứa chính xác `I_UNDERSTAND_REMOTE_INPUT` (một dòng).
- `--unattended` sẽ bị từ chối nếu thiếu `--allow-input` hoặc tệp chấp thuận hợp lệ.
- Mọi sự kiện đều được xác thực theo schema, giới hạn trong màn hình ảo hiện tại và chỉ cho phép một danh sách phím nhỏ. Chế độ không cần giám sát là lựa chọn quản trị rõ ràng, không bao giờ là mặc định ngầm định.

Không chạy agent với quyền quản trị viên trừ khi một tích hợp desktop cụ thể yêu cầu quyền đó. Đặt mặt phẳng điều khiển phía sau HTTPS và dùng ID phiên ngắn hạn.

## Kết nối một agent

Trước tiên, khởi động máy chủ Node (`npm start` tại thư mục gốc của sản phẩm), đăng ký hai thiết bị trình duyệt và tạo phiên theo hướng dẫn trong README gốc. Sau đó, chạy host agent bằng các giá trị thiết bị đích/phiên:

```powershell
$env:HYBRID_CONTROL_URL = 'http://127.0.0.1:8787'
$env:HYBRID_TOKEN = '<token returned by /api/v1/auth/enroll>'
$env:HYBRID_DEVICE_ID = 'dev_...'
$env:HYBRID_SESSION_ID = 'ses_...'

.\agent\.venv\Scripts\python -m hybrid_agent.agent --insecure-http --share-screen
```

Nếu bỏ qua `HYBRID_TOKEN` và `HYBRID_DEVICE_ID`, hãy truyền `--email`, `--name` và (khi đã cấu hình) `--enrollment-token`; agent sẽ thực hiện các lời gọi API khởi tạo và đăng ký thiết bị. Dùng `--download-dir` để chọn nơi ghi tệp nhận được và `--send-file` để gửi một tệp có giới hạn sau khi DataChannel mở.

```powershell
.\agent\.venv\Scripts\python -m hybrid_agent.agent `
  --email host@example.test --name "Windows host" `
  --session-id ses_... --device-name "Host" `
  --insecure-http --share-screen `
  --download-dir C:\Users\me\Downloads\RemoteInbox `
  --send-file C:\Users\me\Desktop\readme.txt
```

Nút **Request host screen** trên trình duyệt yêu cầu agent được khởi động với `--share-screen` cung cấp desktop track. Hành động **Enable input** trên trình duyệt chỉ gửi yêu cầu điều khiển đầu vào sau khi host đã chủ động cho phép bằng `--allow-input` cùng tệp chấp thuận chính xác. Dữ liệu tệp mặc định bị giới hạn ở 8 MiB và sử dụng các khối theo offset, đúng thứ tự, có xác minh SHA-256.

## Kiểm thử

```powershell
py -3.13 -m unittest discover -s tests -v
```

Các kiểm thử không yêu cầu GUI, `aiortc` hoặc `mss`; chúng bao phủ đóng khung/giới hạn tệp, cổng chấp thuận, xác thực thao tác đầu vào, phân tích cấu hình và lượt trao đổi signaling/DataChannel giả lập. Chạy kiểm thử nhanh cho phần phụ thuộc tùy chọn sau khi cài đặt tệp khóa:

```powershell
py -3.13 -m hybrid_agent.agent --self-test-dependencies
```

Kiểm tra tương đương trên artifact đóng gói:

```powershell
.\release\HybridHostAgent.exe --self-test-dependencies
```

## Các hạn chế trước khi dùng trong production

Host sử dụng trạng thái điều khiển/phiên trong bộ nhớ được kế thừa từ nguyên mẫu. Môi trường production cần bằng chứng khóa công khai của thiết bị, quyền chia sẻ/ACL bền vững, bản cập nhật agent có chữ ký, cô lập dịch vụ Windows, ký mã, hành vi UAC/secure desktop rõ ràng, lưu nhật ký kiểm toán bền vững, chính sách quét mã độc/hạn ngạch và hệ thống TURN đã được gia cố. Agent chủ ý không cố vượt qua UAC hoặc chụp các secure desktop được bảo vệ.
