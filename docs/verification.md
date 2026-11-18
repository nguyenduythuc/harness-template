# Kiểm chứng plan bản 2026-10-19

Bản 2026-10-19 có ba lỗi làm sai kết luận đo lường: rule adopt không phát hiện được gain cỡ paper, trigger tạo gain giả, và eval đọc được qua git. Ba lượt đầu tìm 51 lỗi (8 nghiêm trọng, 28 lớn, 15 nhỏ); lượt 4 kiểm lại bản đã sửa và tìm thêm 30 (1 nghiêm trọng, 11 lớn, 18 nhỏ). Tất cả đã được sửa trong tab chính, cùng 16 lỗi phát sinh trong lúc sửa.

## Cách kiểm

1. Tự rà trước khi đọc kết quả của ai khác (28 điểm, S1–S28).
2. Ba verifier độc lập, không thấy kết quả của nhau: red-team containment (V1), phương pháp đo và độ trung thành với nguồn (V2), tính nhất quán và khả năng làm được trên Claude Code (V3).
3. Đối chiếu lại các claim quan trọng của verifier với docs Claude Code tải ngày 2026-10-20, paper, repo harness2 và second brain; tính lại các con số thống kê bằng noncentral t.
4. Một verifier mới đọc bản đã sửa để tìm lỗi còn sót hoặc lỗi mới (mục Lượt 4), rồi đọc lại toàn bộ tab chính sau khi sửa và tính lại bảng MDE80 bằng mô phỏng.

## Lỗi trong bản 2026-10-19

| ID | Mức | Lỗi | Sửa ở bản mới | Ai tìm, evidence |
| --- | --- | --- | --- | --- |
| K01 | Nghiêm trọng | "Adopt" mang ba nghĩa; plan không nói PR chứa gì, nên merge PR của một task có thể đổi H0 ngoài quyết định 5 | Estimand E1 và E2; PR chỉ chứa deliverable; H′ vào library staging; bảng Output và vòng đời | V2-F1, V3-F01; paper §2.2.2: H\*\_t "indicates adoption rather than verified optimality" |
| K02 | Nghiêm trọng | Rule "Δ > 2·SD(H0)" không định nghĩa SD, ước từ 3 run, đo trên dev mà áp cho holdout; với 5 holdout task chỉ phát hiện được gain khoảng 13–17 điểm | Rule paired t với δ\_min, ba trạng thái kết quả, bảng MDE80, gate Phase 0 (Thước đo) | V2-F2, S12; paper Tables 1–2 (gain k=1 trung vị khoảng 4); tính lại bằng noncentral t |
| K03 | Nghiêm trọng | Chỉ cải tiến khi reference tệ rồi so với chính reference đó: gain giả do regression to the mean, khoảng 0.35–0.4 σ\_run tính trên mọi task | Eval tắt trigger; baseline là m lần chạy H0 độc lập (Kiến trúc, Bộ rule) | V2-F3; paper chạy bước cải tiến trên mọi task |
| K04 | Nghiêm trọng | Eval nằm trong repo: đọc được bằng git show, git grep từ mọi worktree, qua @-import (không đi qua PreToolUse) và qua script; lời giải nằm trong history | Eval store ngoài repo; workspace dựng bằng git archive; network bị chặn; canary rải khắp (Enforcement lớp 1) | V1-C1, M6; V2-F6; V3-F02; S4, S7; docs hooks, permissions; V2 thử trên repo thật |
| K05 | Nghiêm trọng | Lớp "read-only bằng chmod" không phải rào: agent cùng user chmod lại được, còn sed -i và mv cần quyền thư mục | Bỏ chmod, thay bằng sandbox strict (lớp 4) | V1-C2, V3-F18, S3 |
| K06 | Nghiêm trọng | Plan không bật sandbox, nên Bash, python, node ghi được file pinned- mà hook không bắt được | Sandbox strict: failIfUnavailable, allowUnsandboxedCommands false, denyWrite (lớp 4) | V1-C3; docs permissions: deny rules "don't apply to … arbitrary subprocesses" |
| K07 | Nghiêm trọng | settings.local.json (không pinned, thường gitignore, ưu tiên cao hơn project) tắt được plugin hoặc mọi hook; CI không thấy | Glob ngoại lệ gồm settings\*.json; launch bằng flag settings; ConfigChange hook | V1-C4, V3-F04, S5; docs plugins/loading, hooks |
| K08 | Nghiêm trọng | File agent-owned của H0 bị sửa trong việc thường và đi vào PR thường; STATE.md đổi mỗi session nên ba run H0 không cùng một harness | Lớp loop-owned, CI chặn; STATE.md thành memory.md (C3), session state ra runs/ | V3-F03, V2-F8, S14; paper App. B: "every rollout is a fresh container" |
| K09 | Lớn | Library học từ chính holdout; holdout dùng lại không giới hạn | Snapshot chỉ đọc, không Reflect trên holdout, holdout-ledger, thay một nửa sau 3 đợt | V2-F4, S9; paper App. A, E.2 |
| K10 | Lớn | Score rò qua kết quả settle (Thức settle sau khi thấy score) và qua PR body (agent có gh) | Ở eval, Reflect chạy trước khi chấm; score không vào PR; agent không có GH\_TOKEN | V2-F7, V3-F12 |
| K11 | Lớn | Chỗ lệch paper không được gắn nhãn; câu "khác Harness² là có scoring ngoài vòng lặp" sai | Sửa câu; thêm mục Mở rộng ngoài Harness² | V2-F5, S10; paper App. A: "Benchmark scores are reserved for evaluation" |
| K12 | Lớn | Công thức score: test ẩn vừa là gate vừa là S\_det; thang đo lệch nhau; lỗi hạ tầng bị tính là 0 | gate = build ∧ typecheck; S\_det chuẩn hoá về \[0, 1\]; run lỗi hạ tầng là unscored | V2-F9, V3-F15; repo EXPERIMENTS.md: "Failed evaluations remain unscored" |
| K13 | Lớn | Success và gate không đo được: gate Phase 0 pass với mọi giá trị SD; "reuse" chưa định nghĩa; gate Phase 5 vô nghĩa; Phase 0 đo SD trước khi H0 thành file | Định nghĩa reuse event, gain per Mtok, Success 3; gate mới cho từng phase; đo lại σ cuối Phase 1 | V2-F10, V3-F15, S11, S17; paper App. E.2, Fig. 6 |
| K14 | Lớn | Calibrate judge bằng 8/10 mẫu không phân biệt được judge 70% với judge 90%; "khớp" không định nghĩa; judge chỉ khác model executor | κ ≥ 0.6 trên ≥ 50 judgment, ≥ 8/10 cặp đúng thứ tự, đo intra-rater, model khác cả editor | V2-F11, S25; P(≥ 8/10 khi độ khớp thật là 0.7) = 0.38 |
| K15 | Lớn | Library chỉ giữ nửa prose, bỏ phần executable; không có key theo domain và executor | Entry = patch H\*\_t + EXPERIENCE.md, theo domain; đổi executor là library mới | V2-F12; paper D.2: "Executable components are retained rather than summarised as prose" |
| K16 | Lớn | D5.B nói quá về library chuyển domain | Một thí nghiệm một chiều, hai trong ba kết quả nằm trong nhiễu; A là mặc định của paper | V2-F13; paper §4, Table 1 |
| K17 | Lớn | "Scoping cho gain lớn nhất với chi phí thấp nhất" sai: trên WorkBuddy bỏ library tốn hơn (3.1 so với 2.9), và paper không báo chi phí | Viết lại lý do thứ tự phase | V2-F14, S2; paper §4, Table 3 |
| K18 | Lớn | Rule of Three bị rút thành phép đếm, bỏ bước "vì sao lặp lại?" và observer bias; ba task có thể cùng một project | Ba kết luận; cần ≥ 2 project hoặc domain; chỉ đếm lần xuất hiện độc lập | V2-F15, S15; second brain CLAUDE.md |
| K19 | Lớn | Tag và TTL lệch nguồn: không có điều kiện lên {fact ✓}; quá TTL thì archive; archive theo usage trái grace floor | Mặc định {hypothesis}; quá TTL thì hạ tag; có grace floor | V2-F16; second brain fact-vs-opinion, hermes-self-improvement-loop |
| K20 | Lớn | Editor chạy headless không ghi được .claude/skills và .claude/agents: protected path, -p mặc định từ chối, allow rule không duyệt trước được, sandbox cũng chặn | Editor ghi vào staging, orchestrator copy vào worktree | V3-F05; docs permission-modes, sandboxing |
| K21 | Lớn | Session của vai R dựa vào auto-discovery mà --bare bỏ; --agent không chặn CLAUDE.md nên H lọt vào mọi vai R; plugin agent bỏ qua permissionMode và hooks; CLAUDE.md đến dưới dạng user message | D6; stage prompt nằm trong roles/; system-prompt.md đổi thành instructions.md | V3-F06, V1-m11, S24; docs headless, sub-agents, plugins/components, memory |
| K22 | Lớn | Run nhiễm chéo qua auto memory dùng chung mọi worktree, CLAUDE.md của thư mục cha và config của user | Tắt auto memory, workspace ngoài repo, fingerprint mỗi run (lớp 2) | V3-F07; docs memory: "All worktrees … share one auto memory directory" |
| K23 | Lớn | Workspace eval không được định nghĩa; snapshot cũ thiếu harness và lộ lời giải qua history | git archive tại base\_sha, rồi chép H đang đo vào | V3-F08, S7 |
| K24 | Lớn | Tín hiệu "Thức sửa tay" chỉ có sau review nên không kích hoạt được quyết định 1; "cùng loại task" chưa định nghĩa | Tách tín hiệu đồng bộ và sau review; task\_type; p75 chỉ tính sau ≥ 10 run | V3-F09, S8, S18 |
| K25 | Lớn | Quyết định 5 không có người đề xuất, không định nghĩa H0′; gate Phase 2 so "H′" với H0 trên dev là vô nghĩa | Consolidator, đợt holdout, PR h0-promotion; gate Phase 2 mới | V3-F10, V2-F1, S10 |
| K26 | Lớn | Library ghi không qua review; "vai duy nhất ghi" sai; template library không có chỗ ở | D7; template library là repo riêng | V3-F11, V1-M7, S16 |
| K27 | Lớn | Workflow hợp lệ của chính plan (đổi owner, upgrade lock, đổi ngưỡng) bị gate và hook của chính nó chặn | Người ghi hợp lệ, label, CODEOWNERS | V3-F13 |
| K28 | Lớn | Quyền đọc, ghi theo vai không được enforce; agent R lộ ra cho executor qua agents/ của plugin | HARNESS\_ROLE và allowlist trong hook; roles/ không đăng ký làm subagent | V3-F14; docs sub-agents |
| K29 | Lớn | Ở production, agent sửa được config của gate (scripts, tsconfig, test) để nới gate | Hash config gate, label người duyệt, CI đếm edit nới gate | V3-F17 |
| K30 | Lớn | Budget token không enforce được như viết: Claude Code chỉ có trần USD ước tính, và có thể vượt | Budget gồm USD và token; orchestrator đo usage của mọi session, chừa headroom | V3-F16; docs cli-reference: "Spend can pass the cap" |
| K31 | Lớn | Không có root of trust local: hook và checksum nằm trong plugin agent sửa được; SessionStart không dừng được session; --plugin-dir nạp tại chỗ | Orchestrator so hash trước khi mở session; CI dựng lại từ source; hook tự fail closed | V1-M5, V3-F18, S23; docs plugins/loading, hooks |
| K32 | Lớn | Score tính trên máy local, nơi agent sửa được weights và judge, lại được đưa vào PR | Chỉ score từ eval run sạch có thẩm quyền | V1-M8, S6 |
| K33 | Lớn | Injection qua file được import và qua library | Library là dữ liệu tham khảo trong stage prompt; quét injection; library vào main qua PR | V1-M7 |
| K34 | Lớn | Hook chỉ chắc với tool có sẵn; Bash parse best-effort; matcher thiếu NotebookEdit, PowerShell, Monitor, MCP | Matcher mở rộng; sandbox là rào cho Bash | V1-M9, V3-F04, S28 |
| K35 | Lớn | Doctor chỉ thử Edit và checksum; không thử Bash, git, settings.local, và không thử "không quá chặt" | Doctor thử từng đường lách với settings của từng vai | V1-M10, V2-F22, V3-F02 |
| K36 | Lớn | runs/ bị gitignore nhưng CI và report tuần lại đọc từ đó | reports/runs/\*.json đã lọc, commit để CI tổng hợp | V3-F19, V2-F23 |
| K37 | Nhỏ | Đóng gói plugin: yarn.lock bị bỏ qua, cài dependency giới hạn 60 giây, biến path không có trong Bash, CLAUDE.md ở gốc plugin không được nạp, settings.json của plugin chỉ nhận 2 key | Orchestrator là CLI riêng dùng npm lockfile; plugin dưới plugins/harness/; settings theo vai truyền qua --settings | V3-F23, S22; docs plugins/loading, plugins/components |
| K38 | Nhỏ | Tên skill trùng lệnh có sẵn (/init, /doctor, /run, /upgrade); Claude tự gọi được skill; skill pinned- bị che theo name | name: harness, disable-model-invocation, CI kiểm trùng name | V3-F22; docs commands, skills |
| K39 | Nhỏ | SessionStart không gánh được doctor; skill vừa sinh cần reloadSkills; mô tả Setup và trust chưa đúng; cài user scope làm guard chạy ở mọi repo | SessionStart chỉ làm phần nhanh; cài project scope; sửa câu về Setup và trust | V3-F20, S20, S21, S27, V1-m13; docs hooks, plugins/org |
| K40 | Nhỏ | Sơ đồ thiếu trigger, nhánh bỏ qua, composed run, selector, đường promote; k mang hai nghĩa | Vẽ lại sơ đồ; tách k\_par và k\_seq | V3-F21, S19 |
| K41 | Nhỏ | Thuật ngữ không được định nghĩa (ξ, Ring 2/3, Partial của LAB…), trái yêu cầu team đọc được | Mục Thuật ngữ | V3-F24 |
| K42 | Nhỏ | "Vì sao hai editor" dẫn evidence về scoping chứ không về số editor | Sửa câu | V2-F17 |
| K43 | Nhỏ | D3: "gain tăng theo k" thiếu khoảng; D3.C là hướng tương lai của paper; chi phí k=1 thiếu session R | Sửa D3 | V2-F18, V2-F19, S13 |
| K44 | Nhỏ | Chỉ một phần component sửa được mà không ghi; guardrails của paper là component sửa được | Tách hai file guardrails; ghi rõ 7/8 | V2-F20 |
| K45 | Nhỏ | "Graduated enforcement" gắn nhầm trục: bảng chia theo ai được đổi, không theo reversibility | Thêm cột effect xấu nhất với AUTO, COMPENSABLE, NONE | V2-F21 |
| K46 | Nhỏ | Split không phân tầng; thứ tự task và seed không được nói | split.json phân tầng, seed riêng | V2-F24 |
| K47 | Nhỏ | Pool của Selector không được nói | Pool gồm cả deliverable của reference | V2-F25 |
| K48 | Nhỏ | Lỗi chính tả đổi nghĩa: "thứ giảm nó" thay vì "thứ giam nó" | Sửa | S1 |
| K49 | Nhỏ | defaultMode auto hay bypass đặt trong project settings không có hiệu lực | Mode đặt lúc launch (D6) | V1-m14; docs permission-modes |
| K50 | Nhỏ | Checksum theo path cache, mà path đổi theo version | Lock ghi git SHA và hash nội dung | V1-m12, S23 |
| K51 | Nhỏ | Chưa tính tới protected path của Yarn: executor không sửa được .yarnrc.yml, .yarn/, .pnp.cjs bằng Edit/Write | Thêm dòng rủi ro | Kiểm lại docs permission-modes ở lượt 3 |
| K52 | Lớn | Skill và agent loop-owned khai được `hooks`, `mcpServers`, `permissionMode`, `model` trong frontmatter, và skill có inline shell (`` !`cmd` ``). Claude Code chạy hook, MCP server và inline shell ngoài guard hook. Lớp "middleware pinned" chỉ chặn theo path nên không thấy đường này | `validateH` chỉ nhận key trong danh sách (spec Agent Skills, bỏ `allowed-tools`); pipeline từ chối H có các key đó trước mọi run, kể cả H0 của người; mọi role settings đặt `disableSkillShellExecution` | Audit theo agentskills.io ngày 2026-10-25; schema frontmatter trong binary Claude Code 2.1.310 |

## Lượt 4: kiểm hồi quy bản đã sửa

Verifier thứ tư (V4) đọc bản đã sửa mà không thấy quá trình sửa. Trong 91 lỗi của ba lượt trước, 65 đã sửa đúng, 23 sửa một phần, 2 sửa sai, 1 không còn áp dụng, và không lỗi nào bị bỏ qua. V4 tìm thêm 30 lỗi: 1 nghiêm trọng, 11 lớn, 18 nhỏ. Tất cả đã được sửa trong tab chính; các lỗi sửa một phần và sửa sai được gộp vào đúng lỗi mới tương ứng bên dưới.

### Lỗi nghiêm trọng và lỗi lớn

| ID | Mức | Lỗi | Sửa ở tab chính | Evidence |
| --- | --- | --- | --- | --- |
| B1 | Nghiêm trọng | Eval store chỉ vắng mặt khỏi workspace, không vắng mặt khỏi máy. Bash của executor đọc được nó bằng absolute path, cùng transcript trong `~/.claude/projects` và `runs/` | D9: đợt holdout chạy executor trong container không mount eval store. Local: `blockReadsOutsideWorkingDirectories`, `denyRead`, `CLAUDE_CONFIG_DIR` riêng, `persistSession: false`; path của eval store ra khỏi project; thêm probe `cat`, `find ~`, Read tool | docs sandboxing: sandbox đọc được "Most of the machine"; docs permissions: `cat`, `grep`, `find` chạy không cần duyệt |
| B2 | Lớn | "Eval run sạch" chưa có định nghĩa, nên theo chính rule của plan thì không score nào có thẩm quyền | D9.B: container dựng từ image ghi trong lock; fingerprint nằm trong mọi report; script quyết định 5–6 chỉ nhận report có fingerprint đó | Suy ra: eval phải gọi LLM, mà GitHub Actions được định nghĩa là không gọi LLM |
| B3 | Lớn | Workspace của executor chứa library, report và pinned config; chưa nói H đang đo được đặt lên snapshot eval thế nào | Production bỏ `library/`, `reports/` khỏi working tree; eval chép H theo tree hash lên bản `git archive` rồi commit làm base; run record ghi `base_sha` và tree hash | Paper: chỉ harness được mount vào container của executor |
| B4 | Lớn | Library PR do người duy nhất thấy score duyệt, nên merge hay reject thành bản sao có tổn hao của score | Library PR không mang task ID hay run ID; Thức duyệt trước khi mở eval report của cùng đợt; kênh còn lại ghi vào bảng Mở rộng | Cùng lập luận với V2-F7 |
| B5 | Lớn | Định nghĩa `confounded` bị rút gọn, làm mọi edit ở k\_par = 1 đều `confounded`, nên library luôn rỗng | Chép định nghĩa của paper vào Thuật ngữ; cho verdict `helped` hay `hurt` khi một thời điểm trong trajectory cho thấy cơ chế; quyết định 4 thành "thu hẹp hoặc bỏ"; Phase 2 báo tỉ lệ row không `confounded` | Paper: "narrow it to what the record does show, or decline" |
| B6 | Lớn | σ\_int không đo được ở Phase 0 vì chỉ có một harness, trong khi gate Phase 0 phụ thuộc vào nó | Phase 0 chỉ đo σ\_run; MDE80 báo ở σ\_int bằng 0, 5 và 10; sau Phase 2, SD của d\_t trên dev dùng để định cỡ holdout | Phân rã phương sai; ở n = 10, MDE80 chạy từ 5.8 tới 9.1, vắt qua δ\_target = 8 |
| B7 | Lớn | Gate Phase 3 "không làm tệ đi" là test non-inferiority thiếu power: ở n = 5, khác biệt thật bằng 0, nó chỉ pass khoảng 22% số lần | Gate thành smoke test: ước lượng ≥ −δ\_min, kèm khoảng tin cậy; ghi rõ test đúng nghĩa cần khoảng 12 task với margin 7.7 | Tính lại bằng scipy, SD của d\_t = 12, α = 0.10 |
| B8 | Lớn | Rollback (quyết định 6) không có kết quả "tệ hơn" và không có đơn vị: library có ích +1 điểm vẫn bị rollback | Thêm kết quả "Tệ hơn" (cận trên 90% nhỏ hơn 0); đơn vị là snapshot, ablation từng lesson làm sau | Suy ra từ rule ba trạng thái |
| B9 | Lớn | Budget tự mâu thuẫn: một chỗ cho chạy lại session chạm budget, hai chỗ cho dừng task; các session song song cùng nhận "phần còn lại" | Session chạm budget không chạy lại; các session song song chia nhau phần còn lại trừ headroom | Paper chỉ retry tree không hợp lệ; docs Agent SDK: chi phí có thể vượt trần khoảng một response |
| B10 | Lớn | Deny rules trong project settings chặn luôn người ghi hợp lệ (`/harness:init`, `/harness:upgrade`), vì deny thắng mọi lần duyệt | Deny rules chuyển vào settings theo vai do orchestrator truyền; session của người được hook hỏi lại thay vì chặn | docs permissions: "deny, then ask, then allow"; docs hooks: deny vẫn được xét bất kể hook trả gì |
| B11 | Lớn | `denyWrite` cho `pinned-*` không có hiệu lực trên Linux và WSL2, vì sandbox bỏ qua entry có wildcard | Orchestrator mở rộng glob thành path tuyệt đối lúc launch; CI chặn file `pinned-` mới; doctor chạy probe trên từng platform | docs settings-reference: entry chứa `*`, `?` hay `[` "has no effect" trên Linux và WSL2 |

### Lỗi nhỏ

| ID | Lỗi | Sửa ở tab chính |
| --- | --- | --- |
| m1 | Score vẫn tới PR `h0-promotion` và output của `/harness:report` | PR chỉ ghi Pass và ID report; `/harness:report` chỉ in token, reuse, Pass/Fail |
| m2 | Epoch theo "major version" của Claude Code không bao giờ kích hoạt; version tối thiểu chưa được kiểm | Epoch mới khi đổi bất kỳ version nào; `system/init` kiểm `claude_code_version` |
| m3 | Canary đặt trong `task.md` sẽ hiện trong mọi trace và làm fail mọi run | Canary chỉ nằm trong rubric, test ẩn, `judge.md`, `meta.yaml`; đoạn giống lời giải thì đưa người xem |
| m4 | Giới hạn network của eval bỏ sót WebFetch và WebSearch | Executor ở eval không có hai tool này; doctor thử WebFetch |
| m5 | Selector không còn đọc task và tài liệu nguồn, hồi quy so với bản cũ | Thêm lại; log lựa chọn để báo tỉ lệ chọn reference |
| m6 | Bảng MDE80 chỉ tính phần cận dưới của rule; δ\_min chưa có giá trị; gate Phase 2 không fail được; calibrate thiếu luật hoà và test-retest | Tính lại MDE80 theo cả rule với δ\_min = 3; gate Phase 2 fail khi "Tệ hơn"; bỏ cặp hoà; judge chấm lại 10 mẫu cùng input |
| m7 | E1 lệch comparator của repo harness2 mà không ghi; "thứ bạn dùng mỗi ngày" sai vì production có trigger | Ghi rõ lệch có chủ ý; ghi rõ E1 không đo pipeline có trigger |
| m8 | Session của orchestrator còn nhận connector claude.ai, plugin đồng bộ và `CLAUDE.md` ở thư mục cha; một câu "docs chưa nói" ở D6 là sai | API key và `CLAUDE_CONFIG_DIR` riêng, `strictMcpConfig`, SessionStart im lặng khi có `HARNESS_ROLE`, workspace dưới gốc sạch, tạo sẵn `.claude/{skills,agents,commands}`; sửa câu ở D6 |
| m9 | `claude --init-only` trong CI không thấy plugin vì CI chưa trust folder | CI nạp plugin bằng `--plugin-dir` tại SHA trong lock; thêm Setup vào `hooks.json` |
| m10 | Sandbox strict có thể phá gate RN và Next.js | Phase 1 chạy thử gate trong sandbox; `jest --no-watchman`; `allowedDomains` cho registry; build native có thể để ngoài gate |
| m11 | H0 còn đổi được ngoài quyết định 5: qua `.git` dùng chung, file instruction lồng trong thư mục con, và `library/` chưa bị chặn | H0 lấy từ SHA trong lock và kiểm tree hash; glob `**/`; CI chặn `library/` và `reports/`; `denyWrite` có path loop-owned |
| m12 | `memory.md` không có đường đổi; patch không ghi base; tag thiếu decay class | `h0-promotion` nhận fact bền theo domain; patch ghi tree hash base, re-base mỗi epoch; tag có decay, mặc định medium |
| m13 | Rule of Three không đếm được lần độc lập, vì mọi editor đều thấy index | "Đã đọc" là đã mở entry, theo log tool call; phần lớn lần đếm sẽ đến từ project khác |
| m14 | Merge theo tuần, Reflect đọc comment review và Consolidator là mở rộng nhưng chưa nằm trong bảng; bước xáo trộn thứ tự task vô tác dụng | Thêm vào bảng Mở rộng; bỏ xáo trộn, ghi rõ library đứng yên trong một đợt |
| m15 | Hash config của gate nằm trong file `pinned-`, nên chặn cả task sửa config hợp lệ | CI giữ hash ở base branch và cập nhật khi PR `gate-change` được merge |
| m16 | Lệch sổ sách: nhịp doctor, quyền ghi của judge và orchestrator, phạm vi budget, số rollout của một đợt | Thống nhất từng chỗ; D8 ghi đủ 360 rollout, 216 session R và 144 lần gọi judge |
| m17 | Ký hiệu trùng (E2 với App. E.2, gate ba nghĩa) và thiếu thuật ngữ | Thêm H0′, contrast, trajectory, canary, workspace fact, growth limit, Meta-Harness; gate ghi rõ ba nghĩa |
| m18 | Secret scan không phát hiện được code của công ty | Mọi lesson rời project qua người duyệt và không chứa code hay tên riêng |

### Phần làm quá tay cho một người

V4 chỉ ra sáu chỗ quá nặng khi mới có một người dùng. Bốn chỗ được rút gọn:

- CODEOWNERS chỉ bật khi có người review thứ hai; trước đó CI kiểm path và đòi label.
- Quyết định 5–6 và Consolidator chỉ bật từ Phase 5; trước đó H0 cố định như trong paper.
- Template library và Rule of Three liên project dời sang Phase 4, khi có project thứ hai.
- Trigger giữ nguyên, nhưng Thức ép được bằng `harness run --improve` hoặc `--no-improve`.

Hai chỗ giữ nguyên. Năm lớp enforcement vẫn giữ, vì container chỉ dùng cho đợt holdout (D9), còn session tương tác cần phát hiện sớm. SessionStart tự sinh (phương án C) vẫn giữ, vì đó là yêu cầu của bạn: cài plugin là project có harness.

## Lỗi phát sinh trong lúc sửa

| ID | Lỗi | Sửa | Phát hiện bằng |
| --- | --- | --- | --- |
| P1 | Ký hiệu R vừa là improvement harness vừa là số lần chạy (mượn từ báo cáo verifier) | Đổi số lần chạy thành m; thêm vào Thuật ngữ | Đọc lại toàn bộ bản mới |
| P2 | Bảng cỡ mẫu của verifier dùng α = 0.05, trong khi rule dùng cận one-sided 90% | Tính lại mọi con số với α = 0.10 | Tính lại bằng scipy |
| P3 | Lưu nguyên cây harness trong library (theo paper) sẽ biến skill và CLAUDE.md lồng bên trong thành instruction đang sống, vì Claude Code nạp chúng khi Claude đọc file ở thư mục đó | Lưu dạng patch; worktree luôn có .claude/skills/ | docs skills: nested skills "load the first time Claude reads or edits a file in that subdirectory" |
| P4 | Đề xuất denyRead của verifier không chặn được Read tool | Ghi rõ lớp 4 luôn đi cùng lớp 3 | docs sandboxing: "A denyRead entry doesn't stop the Read tool" |
| P5 | Sơ đồ ghi growth limit ở gate của deliverable, trong khi growth limit áp cho PR đổi harness | Đổi thành build, typecheck, test | Xem ảnh render của sơ đồ |
| P6 | Gate Phase 1 ghi "doctor chặn mọi đường lách", nói quá: doctor chứng minh mỗi đường bị chặn hoặc bị phát hiện | Đổi thành "doctor pass mọi probe" | Đọc lại |
| P7 | Lớp 1 ghi là lớp duy nhất chặn đọc "qua script", sai vì sandbox cũng chặn được script | Bỏ chữ "script" | Đọc lại |
| P8 | Doctor gọi từ session tương tác, nơi không có sandbox strict, nên probe Bash sẽ cho kết quả sai | Doctor mở session thử với settings của từng vai | Đọc lại |
| P9 | Staging chưa có chỗ ở, trong khi runs/ chỉ orchestrator được ghi | Staging là thư mục ngoài repo, mỗi run một thư mục | Đọc lại |
| P10 | Eval store ghi "chỉ orchestrator và judge đọc", quên chính Thức | Sửa câu | Đọc lại |
| P11 | Lúc viết lại lớp 4, denyWrite của executor vẫn thiếu path loop-owned, nên Bash ghi được vào H đang chạy | Thêm path loop-owned vào denyWrite của executor | Đọc lại; V4 cũng thấy (m11) |
| P12 | Lúc thêm đường trust cho CI, câu về hasTrustDialogAccepted ghi "cách dùng cho CI", mâu thuẫn với câu CI nạp plugin bằng --plugin-dir | Ghi rõ CI không dựa vào entry trong settings mà dùng --plugin-dir | Đọc lại toàn bộ bản rev 80 |
| P13 | Workspace production bỏ library/ khỏi working tree, nhưng history vẫn đọc được qua .git dùng chung của worktree | Ghi rõ giới hạn; chấp nhận vì production không dùng để đo, còn eval dựng bằng git archive nên không có history | docs settings-reference: .git chung "stays readable and writable" trong linked worktree |
| P14 | Thêm D9 nhưng checklist Việc làm ngay vẫn ghi "Chốt D1–D8" | Đổi thành D1–D9 | Đọc lại |
| P15 | Chuyển canary ra khỏi thứ executor nhận (m3), nhưng Thuật ngữ vẫn ghi canary nằm "trong rubric và test ẩn" | Sửa định nghĩa theo vị trí mới | Đọc lại |
| P16 | Lớp 1 đã chặn Read tool, nhưng lớp 4 vẫn ghi denyRead "luôn đi cùng lớp 3" | Ghi rõ denyRead chỉ áp cho Bash; Read tool do lớp 1 và hook ở lớp 3 chặn | Đối chiếu docs blockReadsOutsideWorkingDirectories |

## Kiểm chứng live ngày 2026-10-25

Mục này thay phỏng đoán bằng session thật. Môi trường: container Ubuntu 24.04, bubblewrap 0.9.0, socat 1.8, Node 22.22. Probe L1–L8 chạy bằng Claude Code CLI 2.1.310. Doctor, `harness run` và `harness measure` chạy bằng runtime của Agent SDK, Claude Code 2.1.295. Model: executor claude-haiku-5-5, editor claude-sonnet-5-5, judge claude-opus-5-5. Mỗi probe ghi một marker file. Kết quả đọc từ disk và trace, không đọc từ lời của model. Tổng chi phí: $0.71.

### Code chạy ngoài guard (K52)

| ID | Thử gì | Kết quả | Kết luận |
| --- | --- | --- | --- |
| L1 | Inline shell trong skill, ghi ra ngoài project | Permission check chặn: "Output redirection to …" | Inline shell đi qua permission rules của Claude Code |
| L2 | Inline shell ghi trong project; một hook PreToolUse ghi log mọi tool call | Lệnh chạy. Hook chỉ thấy tool `Skill` | Guard hook không thấy inline shell |
| L3 | Như L2, thêm `disableSkillShellExecution: true` qua flag settings | Lệnh không chạy. Trace có "[shell command execution disabled by policy]" | Switch có hiệu lực qua flag settings |
| L4 | Skill có `hooks:`, không có allow rule | Lệnh gọi `Skill` bị từ chối: skill có field ngoài danh sách an toàn cần duyệt, và session headless không có ai duyệt | Claude Code có một lớp riêng |
| L5 | Như L4, thêm allow rule `Skill` | Hook chạy 4 lần, mỗi tool call một lần | Một allow rule mở đường này |
| L6 | Subagent có `hooks:`, workspace chưa trust (config dir mới, như executor) | Subagent chạy, hook không chạy | Hook của subagent cần workspace trust |
| L7 | Như L6, workspace đã trust | Hook chạy | Một cờ trust mở đường này |
| L8 | Subagent có `mcpServers:`, chưa trust | Server không khởi động | Như L6 |

Kết luận: L4–L8 cho thấy Claude Code có lớp riêng, nhưng mỗi lớp phụ thuộc một trạng thái mà một dòng config lật được. `unsafeH` đứng vững ở mọi trạng thái. `disableSkillShellExecution` là cần thiết, vì L2 chạy mà guard không thấy.

### Toàn bộ harness

| ID | Thử gì | Kết quả |
| --- | --- | --- |
| L9 | `componentsUsed` trên trace thật | Bắt đúng `probe`, `hookprobe`, `scout`. Input của `Skill` là `{"skill": "<name>"}`, đúng như C25 giả định |
| L10 | `validateH` trên H của L1–L8 | Báo cả bốn đường |
| L11 | `harness doctor --live`, 13 tấn công | 13/13 BLOCKED trong 41 giây. Agent thử từng bước. Lớp chặn: deny rule (Edit, settings.local.json), guard hook (sed, python, cat, Read, gh), sandbox EROFS (node), không ai duyệt (`find ~`, skill có hook), placeholder (inline shell), không trust (hook của subagent) |
| L12 | `harness run --force improve` lần 1 | 9 session, outcome composed, $0.29, 1 phút 43 giây. Reference bỏ mất build gate vì `npm run build; echo "exit=$?"` bị từ chối. Editor A nêu đúng moment đó; composed run chạy đủ 4 gate |
| L13 | Growth limit ở L12 | H0 1308 byte, giới hạn 1569 byte. Cả hai editor vượt ở lần đầu, mỗi editor tốn thêm một fix session ($0.067 trên $0.188 tiền editor). Bằng chứng cho C5 |
| L14 | 6 dạng lệnh ghép với settings của executor | Chỉ dạng có `$?` bị từ chối. `;`, `&&`, `2>&1`, `|` đều chạy. Composer ở L12 viết luật quá rộng ("Never chain with ;, &&, 2>&1") từ một lần bị từ chối, dù cùng trajectory có `ls -la && cat` chạy được |
| L15 | Thêm fact `$?` vào H0 template (C28), chạy lại cùng task | Reference chạy đủ 4 gate. Composer giữ base (KEEP_BASE). 5 session, $0.12, 55 giây. Mỗi bên chỉ 1 run, nên chưa có ý nghĩa thống kê |
| L16 | `disableBundledSkills: true` | Input tăng từ 17 676 lên 21 681 token mỗi lần gọi, giống nhau qua 3 lần. Không tắt bundled skills để tiết kiệm token |
| L17 | Executor không có bwrap | Session dừng ngay: "Sandbox required but unavailable", $0. `failIfUnavailable` chạy đúng |
| L18 | Session R với `CLAUDE_CODE_RESTRICTED=1` và `settingSources: []` | Plugin nạp (guard ghi log trong session editor). Không có sự kiện InstructionsLoaded, tức không nạp CLAUDE.md |
| L19 | InstructionsLoaded trong executor | Báo CLAUDE.md và đủ 5 file `@`-import |
| L20 | Builtin plugin | Mọi session nạp thêm `cc-plugin-agents-md`, `cc-plugin-telemetry`, `cc-plugin-plugin-authoring` (`@builtin`). Init check chấp nhận chúng |

### Lỗi live test tìm ra và đã sửa

| ID | Lỗi | Hậu quả nếu không sửa | Sửa |
| --- | --- | --- | --- |
| R1 | Judge với `outputFormat` có thêm tool `StructuredOutput`; init check coi đó là tool lạ và huỷ session | Không run eval nào có score. Phase 0 không chạy được | `allowedTools` của judge có `StructuredOutput`; fake SDK của test thêm tool này như SDK thật |
| R2 | `harness upgrade` từ chối chạy khi lock không khớp, trong khi doctor bảo chạy upgrade để sửa lock | Vòng tròn: không nâng cấp được bằng lệnh | `loadCtx(..., { allowLockMismatch: true })`, chỉ cho upgrade |
| R3 | Hidden test lỗi cấu hình (`node --test <dir>` trên Node 22) cho S_det = 0 mà không báo gì | sigma và score sai mà người không biết | Report có mục "Warnings about the measurement" khi hidden test fail ở mọi run mà judge pass mọi criterion; terminal in số warning |
| R4 | Doctor ghi BLOCKED cho các probe khi session executor không khởi động | Báo "chặn được" cho bước không ai thử | Một dòng CRASH "executor session" |
| R5 | Run record mất lý do của fix session | Không debug được chi phí của growth limit | `firstProblems` trong record (C27); message growth limit nêu số byte cần bỏ và byte từng file |
| R6 | `meta.yaml` hỏng cho stack trace YAML, không nêu task | Mất thời gian tìm file | Lỗi nêu `tasks/<id>/meta.yaml` |

## Thử trên monorepo thật ngày 2026-10-26

Môi trường: iMac, macOS, ổ ngoài APFS, Node 22.22.1 qua nvm, Yarn 3.6.4 (node-modules linker), một monorepo React Native private (bản clone, 3 594 file tracked, node_modules 3.2 GB). Project được thêm package `packages/ota-core` (bước S0 của plan OTA) và 4 eval task (c3, c4, c5, c7) có hidden test và lời giải tham chiếu. Session agent không chạy: Claude Code trên máy đã logout, và người dùng chọn ước lượng phần có model. Mọi số dưới đây là số đo thật, không gọi model, 0 token.

### Số đo

| ID | Thử gì | Kết quả |
| --- | --- | --- |
| T1 | Workspace eval: `git archive` ở base_sha, `git init`, commit base | archive 3.5 giây (267 MB, 3 594 file), commit 4.4 giây |
| T2 | `workspace_setup`: `cp -cR` node_modules (C31) | 24–26 giây. Cả workspace chiếm khoảng 0.4 GB đĩa, không phải 3.2 GB. Symlink workspace (`node_modules/@lfvn-customer/*`) là path tương đối, nên trỏ vào package của chính workspace. Không có symlink tuyệt đối |
| T3 | Gate ở base (stub) | build 13.1 giây, typecheck 0.8, lint 1.5, test 28.9; tổng 44 giây, pass |
| T4 | Gate với lời giải tham chiếu | build 11.4, typecheck 0.8, lint 1.2, test 23.1; tổng 37 giây, pass |
| T5 | Hidden test ở base và với tham chiếu | base 0/12, 0/17, 0/11, 0/11; tham chiếu 12/12, 17/17, 11/11, 11/11; mỗi lần 0.6–0.7 giây |
| T6 | `harness doctor` (static và guard self-test) trên macOS | 0 FAIL. 4 WARN đúng như mong đợi: chưa có h0_sha, chưa có credential, lesson store tắt, chưa có eval-check. Guard: 14 BLOCKED, 2 OK |
| T7 | `harness eval-check` trên 4 task | 4 OK, 0 WARN, 0 FAIL trong 8 phút 57 giây (117–122 giây mỗi task, 0 token). Doctor in "[OK] eval check". Đối chứng âm: đặt `/usr/local/bin` lên đầu PATH (Node 18, như R7), rồi chạy lại cho c7. Lệnh báo FAIL trong 66–68 giây và exit 2. Dòng FAIL nêu đúng nguyên nhân: "SyntaxError: … does not provide an export named 'styleText'" |

### Lỗi tìm ra và đã sửa

| ID | Lỗi | Hậu quả nếu không sửa | Sửa |
| --- | --- | --- | --- |
| R11 | Bản sửa R10 nằm trong plugin, nhưng scaffold chỉ tạo file mới, nên bản copy cũ trong monorepo vẫn còn. Pre-commit hook của project chạy `eslint .` và build Next.js, nên commit của người dừng ở file đó | Mọi fix cho file CI copy không tới project nào | `harness upgrade` đề xuất bản mới (`.harness-proposed`); doctor cảnh báo khi bản copy khác plugin (C37) |
| R10 | Scaffold chép `ownership.mjs` vào `.github/harness/lib/`, và linter của project kiểm file đó. Một dòng `if (…) return true; return false;` fail rule sonarjs (T16) | Root lint của project fail ngay sau scaffold; agent tốn bước cho lỗi không phải của task | Một `return` duy nhất, như `ownership.ts` |
| R9 | Editor và composer chỉ biết growth limit sau khi proposal bị loại (T11) | Mỗi run pipeline tốn thêm 3 fix session, 21% chi phí | Prompt đầu tiên của editor và composer nêu limit, số byte hiện có, số byte còn thêm được và số byte từng file (C36) |
| R7 | `runShell` chạy `bash -lc`. Login shell trên macOS chạy `path_helper`, đưa `/usr/local/bin` lên đầu PATH, nên gate chạy Node 18.20 thay cho Node 22 của nvm. vitest 4 dừng với "Startup Error: … does not provide an export named 'styleText'" | Gate test fail và hidden test 0/51 cho mọi deliverable, kể cả lời giải đúng. Một lần measure đầy đủ (khoảng 1 giờ) cho σ\_run và score sai | `bash -c`: lệnh nhận PATH của process harness (C33). Unit test kiểm không có login shell và PATH đi qua nguyên vẹn |
| R8 | Không có cách kiểm thước đo trước khi đo. R3 và R7 là cùng một loại lỗi, và cả hai chỉ lộ ra sau khi tốn session | Mỗi lỗi thước đo tốn một lần đo | `harness eval-check`: workspace, setup, gate và hidden test ở base và với `tasks/<id>/reference/`, không có session. Doctor in kết quả lần gần nhất; `measure` cảnh báo khi chưa có (C33) |

### Run thật ngày 2026-10-27 (một task, m = 1)

Thức tạo token bằng `claude setup-token`, rồi chạy `harness measure --m 1 --only c4-select-release` và `harness eval --split dev --m 1 --only c4-select-release`. Model: executor claude-sonnet-5-5, editor và composer claude-opus-5-5, judge claude-haiku-5-5.

| ID | Thử gì | Kết quả | Ước lượng hôm trước |
| --- | --- | --- | --- |
| T8 | 6 session executor (2 run H0, reference, 2 probe, composed) | 7–12 turn, 43–78 giây, 0.11–0.26 triệu token, $0.13–0.23 mỗi session | 14–24 turn, 2–5 phút, 0.3–0.65 triệu, $0.20–0.39. Tôi ước lượng gấp 2 lần: executor chỉ đọc file cần, không đi khám repo |
| T9 | Một run H0, cả chấm điểm | 3 phút. Score 90 ở cả 2 run: hidden test 17/17, lint pass, judge fail tiêu chí `tests` (không viết test) | 3.4–6.8 phút; H0 90–98 |
| T10 | Một run pipeline | 11 session, 9 phút 6 giây, 1.27 triệu token, $2.00. Outcome composed. Score 100: thêm tiêu chí `tests` | 11–26 phút, 1.7–5.0 triệu, $1.5–4.1 |
| T11 | Growth limit | Cả 3 proposal (editor A, editor B, composer) vượt limit ở lần đầu. 3 fix session tốn $0.42, tức 21% chi phí của run. Composer ghi: "I could not measure it with a tool" | L13 cũng 2/2 |
| T12 | `costUsd` với token subscription | Có giá trị, khác 0, nên `budget.usd` chặn được | Chưa kiểm |
| T13 | E1 | "too few tasks": rule cần ít nhất 2 task. d_t = 10 trên 1 task, 1 run mỗi arm: chưa phải bằng chứng gain | Tôi không báo trước điều này |
| T14 | Cặp eval thứ hai trên c4, sau C36 | 0 fix session (lần trước 3). Pipeline: 8 session, 7.8 phút, 1.16 triệu token, $1.51 (lần trước 11 session, 9.1 phút, 1.27 triệu, $2.00: chi phí giảm 24%). Score: H0 100, pipeline 100, d_t = 0 | – |
| T15 | Score H0 qua 3 run trên c4 | 90, 90, 100. Chỉ tiêu chí `tests` của judge đổi. d_t = 10 của cặp đầu nằm trong biến thiên của chính H0 | – |
| T16 | Lint ở root của monorepo | Fail vì file của harness: `.github/harness/lib/ownership.mjs:119`, rule `sonarjs/prefer-single-boolean-return`. Reference tốn một bước cho lỗi này | R10 |
| T17 | `eval-check` trên eval set 12 task (8 task mới: C6, S1, L1, M2, D2, S5, M3, D3) | 11 OK, 1 FAIL trong 27 phút 51 giây. FAIL: lời giải tham chiếu của L1 vi phạm rule `no-await-in-loop` của project. Sau khi viết lại bằng chuỗi promise: 12/12 OK. Mỗi task mới có 2 mutant; mỗi mutant mất 1–2 hidden test | – |
| T18 | `harness measure` trên 7 task dev, m = 3, executor claude-sonnet-5-5 | 21/21 run có score, 0 cảnh báo, 58 phút, 5.5 triệu token, $4.71. σ\_run = 4.7. Gate Phase 0 PASS: MDE80 = 6.9 ở n = 5 holdout, σ\_int = 5. Score trung bình H0: c3, c4, d2 100; s1 95.8; c6 93.9; l1 91.7; m2 81.9; cả nhóm 94.8. Hidden test 100% ở 21/21 run. Điểm mất đến từ lint của project (6/21 run: `no-await-in-loop`, `no-promise-executor-return`) và tiêu chí `tests` của judge (4/21 run). Tiêu chí dừng (H0 ≥ 90 ở ≥ 4/7 task) chạm ở 6/7: dừng vòng lặp trên bộ task này. Khoảng trống tối đa là 5.2 điểm, nhỏ hơn MDE80, nên E1 hay E2 không thể Pass dù harness tốt tới đâu | Plan: H0 30–85 mỗi task |

### Dự đoán từ số đo, chưa chạy

| ID | Dự đoán | Bằng chứng | Việc đã làm |
| --- | --- | --- | --- |
| U1 | Ở monorepo, pipeline arm chạm `budget.tokens` (2 000 000) trước composed run. Kết quả T10: không chạm ở c4, run dùng 1.27 triệu (64% trần). Task cần gấp đôi số turn sẽ chạm | `totalTokens` cộng cả cache read. Mỗi lần gọi model đọc ít nhất 17 676 token (L16). Executor trên toy project 2 file đã tốn 151 000–184 000 token trong 7–10 turn. Nếu task ota-core cần 14–24 turn, mỗi session executor tốn 0.3–0.65 triệu token. Pipeline có 4 session kiểu executor, 2–4 session editor và 1 composer: 1.7–5.0 triệu token. Ở mức giữa, 6 session đầu đã vượt 2 triệu, nên composed run không chạy | Report của measure và của đợt eval cảnh báo khi budget dừng hơn 5% run của một arm (C34). Chọn cách đếm token là quyết định của Thức |

## Lesson learned

1. **Định nghĩa đối tượng trước khi đặt ngưỡng.** Một chữ "adopt" mang ba nghĩa thì không con số nào kiểm chứng được nó (K01, K25).
2. **Tính power trước khi tin một rule.** "Hơn 2 SD" nghe chặt nhưng không thấy được gain cỡ paper ở eval set nhỏ. Luôn tính MDE từ σ đo được, và giữ α của rule khớp với α của bảng cỡ mẫu (K02, K13, P2).
3. **Điều kiện kích hoạt là một bộ lọc chọn mẫu.** Chỉ cải tiến khi kết quả tệ, rồi so với chính kết quả đó, luôn cho gain giả (K03).
4. **Chặn đọc không bằng vắng mặt.** Thứ gì có trong repo hay history đều đọc được qua một đường không đi qua hook (K04, K09, K23).
5. **Rào phải là thứ agent không tự gỡ được.** chmod, hook nằm trong plugin mà agent sửa được, và settings bị file khác đè đều không phải rào (K05–K07, K31, K34).
6. **Ranh giới owner phải phủ cả thứ đổi trong việc thường.** H0 trôi qua những PR bình thường, không cần ai cố ý lách (K08, K27, K28).
7. **Nhãn suy ra từ score cũng là score.** Kết quả settle, comment và PR body đều là kênh rò (K10).
8. **Mượn rule từ nguồn thì mượn cả điều kiện của nó.** Rule of Three có bước "vì sao lặp lại", TTL hạ tag chứ không archive, ablation chỉ là một cấu hình. Rút gọn một rule là đổi rule (K16–K19, K42, K43).
9. **Fact về tool hay ngược trực giác và decay nhanh.** .claude/ là protected path, --bare sắp thành mặc định của -p, auto memory dùng chung giữa worktree, skill lồng được nạp khi đọc file. Kiểm từng flag trong docs hiện hành trước khi thiết kế quanh nó (K20–K22, K37–K39, K51, P3, P4).
10. **Gắn nhãn mọi chỗ lệch paper.** Phần mở rộng không có evidence của paper phải được đo riêng trước khi tin (K11, K44).
11. **Thiết kế lối ghi hợp lệ cùng lúc với rào.** Rào không có lối hợp lệ sẽ chặn chính workflow của mình (K27).
12. **Câu trả lời trong chat đi vào doc mà không kiểm lại thì lỗi đi theo.** Bốn lỗi của bản cũ (scoping, chi phí k=1, chmod, 2·SD) đến từ câu trả lời trước đó của mình; mọi claim định lượng vào doc phải có nguồn mở được (K02, K05, K17, K43).
13. **Bản sửa cũng sinh lỗi mới.** Mười sáu lỗi P1–P16 xuất hiện trong lúc sửa; chỉ bắt được chúng nhờ đọc lại toàn bộ, xem ảnh render sau mỗi lượt sửa lớn, và cho một verifier mới đọc bản đã sửa.
14. **Vắng mặt khỏi workspace chưa phải vắng mặt khỏi máy.** Bash đọc được gần hết máy, kể cả transcript của run trước; rào local phải tính cả đường đọc theo absolute path (B1).
15. **Đặt deny rule ở đâu quyết định ai ghi được.** Deny thắng mọi lần duyệt, nên deny ở project settings chặn luôn cả người (B10).
16. **Cùng một setting có thể khác nhau theo platform.** Wildcard trong `denyWrite` chạy trên macOS nhưng bị bỏ qua trên Linux và WSL2, nên doctor phải chạy trên từng platform (B11).
17. **Gate phải fail được khi có lỗi và pass được khi không có lỗi.** Gate không thể fail là trang trí; gate thiếu power thì fail cả khi mọi thứ đúng (B7, m6).
18. **Người thấy score mà merge hay trigger cũng là kênh rò.** Quyết định của người đã xem report là bản sao có tổn hao của score (B4).
19. **Rút gọn một định nghĩa có thể đổi hệ quả của cả hệ thống.** Bỏ vế "không có thời điểm nào trong trajectory cho thấy cơ chế" khỏi định nghĩa `confounded` khiến library ở k = 1 luôn rỗng (B5).
20. **Đổi một định nghĩa thì tìm mọi chỗ dùng nó.** Năm trong sáu lỗi P11–P16 là chỗ dùng cũ còn sót sau khi định nghĩa đã đổi.
21. **Rào theo path không thấy code nằm trong một file được phép ghi.** Spec Agent Skills có 6 field, nhưng Claude Code đọc thêm `hooks`, `mcpServers`, `permissionMode`. Kiểm schema mà runtime thật đọc, không chỉ schema của spec (K52).
22. **Test pass với fake SDK chưa chứng minh code chạy với SDK thật.** Mọi test với fake SDK đều pass, nhưng judge hỏng ở lần gọi thật đầu tiên (R1), vì fake SDK không thêm `StructuredOutput` như SDK thật. Mỗi lần tìm ra một khác biệt, sửa cả fake để test bắt được lần sau.
23. **Một lần thất bại chưa đủ để viết luật.** Composer suy ra "không dùng ;, && " từ một lệnh bị từ chối, trong khi cùng trajectory có phản ví dụ (L14). Trước khi viết luật, tìm lệnh tương tự đã chạy được.
24. **Tín hiệu 0 ở mọi run là dấu hiệu của thước đo, không phải của agent.** Hidden test fail 4/4 trong khi judge pass 4/4 (R3).
25. **Shell của lệnh tự động phải giống shell của người.** Trên cùng một máy, `zsh -lic`, `zsh -lc` và `bash -lc` cho ba bản Node khác nhau (22.22, 23.3, 18.20). Kiểm `node -v` trong đúng shell mà tool dùng, không kiểm trong terminal của mình (R7).
26. **Kiểm thước đo bằng một lời giải đúng trước khi đo agent.** Hidden test phải fail ở base và pass với lời giải tham chiếu. R3 và R7 đều lộ ra ở bước này trong vài phút, với 0 token (R8).
27. **Đo một run thật trước khi lên kế hoạch budget.** Tôi ước lượng executor tốn 14–24 turn; thực tế 7–12. Một run tốn 3 phút đã sửa mọi con số của kế hoạch (T8–T10).
28. **Một lỗi lặp lại ở mọi lần thử là lỗi của thiết kế.** Growth limit loại proposal 2/2 ở L13 và 3/3 ở T11. Nguyên nhân: editor không có số đo trước khi viết (R9).
29. **Một cặp run không phải bằng chứng gain.** Cặp đầu cho d_t = 10, cặp sau d_t = 0 trên cùng task. Biến thiên của H0 đủ lớn để tạo ra con số đó (T15).
30. **Lời giải tham chiếu cũng phải qua gate của project.** Hidden test pass 11/11, nhưng lint của project fail. Không có eval-check, mọi deliverable viết đúng như tham chiếu sẽ mất phần lint mà không ai biết vì sao (T17).
31. **Tính khoảng trống trước khi đo gain.** Gain tối đa bằng 100 trừ score của H0. Khi khoảng trống nhỏ hơn MDE80, không phép đo nào Pass được. Ở T18 là 5.2 so với 6.9. Gate Phase 0 PASS ở đây là tín hiệu dễ hiểu sai: σ\_run nhỏ chủ yếu vì H0 chạm trần.
32. **Với model mạnh và spec rõ, chỗ hở nằm ở luật của repo, không nằm ở logic.** Hidden test pass 100%, nhưng 6/21 run fail lint của project. Một dòng trong H0 sửa được chỗ hở đó, không cần vòng lặp (T18).

## Chưa kiểm chứng, cần thử ở Phase 1

- `--restricted` (hay CLAUDE\_CODE\_RESTRICTED=1) có nạp CLAUDE.md và plugin truyền qua --plugin-dir không; docs không nói. Plugin không nạp thì hook theo vai không chạy trong session R.
- `@`-import trỏ ra ngoài working directory có nạp mà không cần duyệt trong `-p` và Agent SDK không; docs chỉ mô tả hộp thoại ở session tương tác. Điều này quyết định editor có kéo được file ngoài vào context của probe không. (Câu hỏi cũ về `settingSources: ["project"]` đã có câu trả lời trong docs, xem m8.)
- Hook InstructionsLoaded có báo đủ mọi file `@`-import không.
- Hook deny có thắng `bypassPermissions` không. Thiết kế không dùng bypass, nhưng cần biết.
- `disableSkillShellExecution` truyền qua flag settings của Agent SDK có thay inline shell bằng placeholder không; code của binary 2.1.310 đọc nó từ settings đã gộp, nhưng chưa thử bằng session thật. Hook trong frontmatter của skill project có chạy trong session headless không; nếu có thì `unsafeH` là rào duy nhất (K52).
- Plugin hook bị sửa trong cache có hiệu lực ngay trong session hay chỉ từ session sau.
- Ngữ nghĩa `pull_request_target` và required workflow của GitHub, cùng luật CODEOWNERS khi chỉ có một maintainer; chưa kiểm ở docs GitHub.
- Plugin đồng bộ từ claude.ai có nạp khi session xác thực bằng API key, với `settingSources: []` và `CLAUDE_CONFIG_DIR` riêng không.
- Trong Agent SDK có `canUseTool`, kết nối từ sandbox tới host ngoài `allowedDomains` được xử lý ra sao; docs chỉ có bảng cho session tương tác.
- Workspace `git archive`, Yarn 3, Metro, xcodebuild và Gradle có chạy được dưới sandbox strict (Seatbelt, bubblewrap) không; chỉ thử mới biết.
- `gh` có dùng credential đã lưu (keyring, `hosts.yml`) khi không có `GH_TOKEN` không; nếu có thì deny `Bash(gh *)` là rào duy nhất.
- Số liệu chỉ có trong hình của paper (Fig. 5–8, 10–13) mới được kiểm ở những chỗ text nhắc lại.
- Comment còn mở ở mục Việc làm ngay: eval set lấy từ repo cá nhân hay cả repo công ty, quyết định eval store đặt ở đâu.
