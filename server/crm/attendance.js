'use strict';

// E08-D031 — trạng thái THAM DỰ của khách: `du` | `khong` | `cho`.
//
// Trục này KHÁC hẳn `checked_in`:
//   * `att_status` = khách CÓ dự sự kiện không (số đi vào báo cáo BTC).
//   * `checked_in` = khách ĐÃ tới cửa chưa (số của lễ tân trong ngày).
// Hai nút ở cửa không được đụng nhau.
//
// MỘT luật, ba nơi dùng (list · detail · /crm/stats). Không để client tự suy từ
// `tags`: D016 đã có bài học client tự đếm tag nên nói 303 trong khi KPI nói 350.

// Buổi khai trên form nằm ở `rsvp_submissions.sessions` — free text người dùng
// gõ. Khớp phải có BIÊN TỪ: '%ala%' cũ khớp cả "Salad" và "Balalaika".
const SESSION_RE = {
  'toa-dam': '(^|[^[:alpha:]])(t[oọ]a[ ]?đ[aà]m|toa dam)([^[:alpha:]]|$)',
  gala: '(^|[^[:alpha:]])gala([^[:alpha:]]|$)',
};

// Khớp ĐÚNG TOKEN trong chuỗi tag phân cách bằng dấu phẩy — cùng quy ước D020,
// nên `gala-vip` không bao giờ bị đếm là `gala`.
const TAG = (col, t) => `(',' || COALESCE(${col},'') || ',') ILIKE '%,${t},%'`;

// Buổi HIỆU LỰC = tag danh sách ∪ buổi khai trên form.
// `idCol` là cột id dùng trong subquery (list có alias `g`, detail thì không).
// `tdRef`/`gaRef` là tham chiếu regex phía SQL: '$2' nếu truyền tham số, hoặc
// một literal đã bọc nháy nếu nhúng thẳng — để hai chỗ gọi giữ nguyên cách viết
// vốn có, không phải sửa câu SQL đã qua Gate 2.
function duSql(alias, idCol, tdRef, gaRef) {
  const a = alias ? alias + '.' : '';
  const sub = (ref) => `(${a}response_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM rsvp_submissions s WHERE s.id = ${idCol} AND s.sessions ~* ${ref}))`;
  return {
    td: `(${TAG(a + 'tags', 'toa-dam')} OR ${sub(tdRef)})`,
    ga: `(${TAG(a + 'tags', 'gala')} OR ${sub(gaRef)})`,
  };
}

// Phân hoạch §2 — RỜI NHAU và PHỦ KÍN khách active, xét theo đúng thứ tự ưu tiên:
//   1. Tham dự      = có buổi hiệu lực
//   2. Không dự     = tag `khong-du` và KHÔNG thuộc (1)
//   3. Chưa xác nhận= phần còn lại
// TRỐNG ≠ "không dự". Mặc định "tất cả tham dự" là điều spec cấm.
//
// `att_override` do người sửa tay ghi, đứng TRƯỚC mọi tín hiệu suy ra. NULL =
// chưa ai đụng ⇒ 344 thẻ hôm nay không đổi một con số nào sau khi thêm cột.
// Tín hiệu gốc (tag) không bị phá ⇒ xoá override là trở về đúng nguyên trạng.
function attSql(alias, du) {
  const a = alias ? alias + '.' : '';
  return `CASE
      WHEN ${a}att_override IN ('du','khong','cho') THEN ${a}att_override
      WHEN (${du.td} OR ${du.ga}) THEN 'du'
      WHEN ${TAG(a + 'tags', 'khong-du')} THEN 'khong'
      ELSE 'cho'
    END`;
}

const STATUSES = ['du', 'khong', 'cho'];
const isStatus = (s) => STATUSES.indexOf(s) > -1;

module.exports = { SESSION_RE, TAG, duSql, attSql, STATUSES, isStatus };
