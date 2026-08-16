# Phối hợp R0 / R1 — Landing RSVP 08/08  
## (bản SoT → copy thành `AGENTS.md` trên GitHub)

> Đọc kèm: [`2026-07-24-hai-pm-con-cung-repo.md`](2026-07-24-hai-pm-con-cung-repo.md) — **hai người + hai PM con**.

| Ai đọc file này? | |
|---|---|
| **Chính** | **Hương Ly** + **PM-con-Ly** (mỗi session: `git pull` → đọc `AGENTS.md`) |
| Tham chiếu | **anh Kha** + **PM-con-Kha** (biết ranh giới, không đụng FE Ly ngoài wiring) |
| Không phải | Phiếu giao việc backend — đó là việc **PM-con-Kha** (xem dispatch Railway MVP) |

SoT điều phối: `Projects_S2-coord/projects/event-08-08/` — **PM tổng** cập nhật sau mỗi session với anh Kha.

---

## 1. Sản phẩm (không nhầm)

| Đúng | Sai |
|---|---|
| Form = **chính landing** (`dang-ky` / `tiec-toi`) | ❌ Không có Google Form riêng |
| SoT = Postgres Railway + `/admin` | ❌ Sheet / Apps Script không còn đường chính |
| 2 trang = một form; `tiec-toi` chỉ `__GALA_ONLY__` | ❌ Tự tách submit lung tung |

---

## 2. Bốn vai (bắt buộc gọi đúng tên)

| Mã | Người | Agent | Việc |
|---|---|---|---|
| **R0** | Hương Ly | **PM-con-Ly** | Frontend nội dung/UX |
| **R1** | Hoàng Kha | **PM-con-Kha** | Backend Railway / DB / admin |
| **PMt** | — | PM tổng (coord) | Spec · Gate · phiếu **ghi rõ** PM-con-Kha hay PM-con-Ly |

---

## 3. Luật cho PM-con-Ly (+ Ly)

### Mỗi session

1. `git pull origin main`  
2. Đọc `AGENTS.md` + `reports/STATUS.md` (nếu có — do **PM-con-Kha** ghi)  
3. Chỉ sửa FE trang khách  
4. Không đổi `collect()` / payload JSON nếu **anh Kha / PM-con-Kha** chưa OK  
5. Giữ: `RSVP_ENDPOINT="/api/rsvp"` · `RSVP_SOURCE` · honeypot · `fetch` JSON (không `no-cors`)  
6. Không commit secret  
7. Push khi Ly / anh Kha đồng ý nhịp  
8. Báo Signal: sửa gì · file · đã push chưa  

### Cấm (PM-con-Ly)

- Đụng `server/**` · env · password · phục hồi Sheet SoT · Google Form  

### Được

- Chữ, ảnh, layout, mobile — trong 2 HTML khách  

---

## 4. Ranh giới file

| Path | Ai |
|---|---|
| `dang-ky.html`, `tiec-toi.html`, `index.html` | **R0 / PM-con-Ly** chính · **PM-con-Kha** chỉ wiring Gate 1 |
| `config.js` | **PM-con-Kha** set endpoint |
| `server/**` | **Chỉ PM-con-Kha** |
| `reports/STATUS.md` | **PM-con-Kha** |
| `AGENTS.md` | SoT từ PM tổng · **PM-con-Kha** commit lên GH · **PM-con-Ly** chỉ đọc |

---

## 5. Khối dán — mở session **PM-con-Ly**

```
Em là PM-con-Ly (Agent của Hương Ly, R0) trên repo esuhai-20nam-rsvp.
Không phải PM-con-Kha — em không làm backend/Railway.
1) git pull
2) Đọc AGENTS.md (+ reports/STATUS.md nếu có)
3) Chỉ frontend 2 trang khách. Không đụng server/, env, password.
4) Giữ RSVP_ENDPOINT=/api/rsvp, RSVP_SOURCE, honeypot, fetch JSON.
5) Không đổi collect()/payload trừ khi anh Kha (R1) OK.
6) Xong: tóm tắt file + hỏi trước khi push nếu chưa được bảo push.
```

---

## 6. Khối dán — nhắc **PM-con-Kha** (không nhầm vai)

```
Em là PM-con-Kha (Agent của anh Kha, R1).
Backend + Railway + AGENTS.md lên GitHub là việc của em.
Không redesign copy/layout của Ly ngoài wiring Gate 1 đã duyệt.
Khi xong session kỹ thuật: cập nhật reports/STATUS.md.
```

---

## 7. Deploy — `main` là nguồn LIVE (từ 16/08/2026)

Service Railway **esuhai-web** đã nối nguồn vào GitHub `main` (serviceConnect,
16/08/2026) — deploy từ nguồn này luôn mang ĐÚNG commit trên `main`, hết cảnh
`railway up` đẩy working tree lệch repo. Vế **tự deploy khi push** cần thêm
Railway GitHub App được cấp quyền repo (anh Kha đang chốt); kiểm tra nhanh:
push xong mở Railway → esuhai-web → Deployments, thấy commit vừa push là auto
đã chạy. Chưa thấy thì deploy tay bằng `railway up`.
⇒ Hệ quả cho mọi vai: **cái gì chưa đáng LIVE thì đừng để lọt vào `main`.**

---

*PM tổng · 2026-07-24*
