export const planningAgentInstructions = `# 기획 폴더 작업 안내

이 폴더의 YAML과 \`documents/**/*.md\`가 원본이다. 읽기·편집·검증은 vibe CLI로 한다. GUI와 같은 core가 규칙을 검사한다.

기존 시트나 Notion 내보내기를 옮길 때는 [vibe-import 스킬](.agents/skills/vibe-import/SKILL.md)을 읽는다. 원본 조사는 \`vibe source inspect <file> --json\`, 쓰기 미리보기는 \`edit/apply --dry-run\`과 \`plan create/variant/status/approve --dry-run\`이다. 이미 승인된 단순 표는 기존 import plan/apply를 써도 된다. 원본끼리 다른 값과 새 해석이 필요한 부분은 사람이 결정할 목록으로 남긴다.

## CLI 찾기

\`vibe --help\`가 실행되면 그대로 쓴다. 없다면 설치된 VS Code 확장에 포함된 CLI를 사용한다. Node.js 24 이상과 VS Code의 \`code\` 명령이 PATH에 있어야 한다. 실행 파일이 없으면 설치 문제를 보고하고 YAML을 직접 편집하는 방식으로 우회하지 않는다.

Windows PowerShell:

\`\`\`powershell
$vibeExtension = (code --locate-extension ijun17.vibe-spec).Trim()
$vibeCli = Join-Path $vibeExtension 'dist/vibe.cjs'
function vibe { node $vibeCli @args }
vibe --help
\`\`\`

macOS/Linux:

\`\`\`sh
vibe_cli="$(code --locate-extension ijun17.vibe-spec)/dist/vibe.cjs"
vibe() { node "$vibe_cli" "$@"; }
vibe --help
\`\`\`

함수·변수는 현재 셸에서만 유지된다. 새 셸에서는 다시 설정하거나 CLI 파일의 전체 경로를 \`node\`에 전달한다. npm에서 이름이 같은 다른 패키지를 설치하지 않는다.

## 읽기와 결과 해석

현재 폴더를 기획 루트로 사용한다. Windows PowerShell에서는 특히 []가 든 경로에서 시작 위치가 달라질 수 있으므로 Set-Location -LiteralPath로 기획 루트에 이동하거나 매번 --project에 기획 루트의 절대경로를 지정한다. 다른 위치에서 실행하면 \`--project <기획 폴더>\`를 붙인다. \`tables/**/*.yaml\`의 파일 이름이 테이블 이름이다. 열 코드명과 Key 열은 읽은 스키마를 따른다. 아래 이름은 예시이며 사용자 데이터의 이름으로 바꾼다.

\`\`\`sh
vibe read items --target base --json
vibe read items/currency_gold --target base --json
vibe read 'items/currency_gold/name' --target base --json
vibe validate --json
\`\`\`

JSON 결과는 \`{ok, revision, data, diagnostics}\`이고 읽기·편집 대상은 최상위 \`target\`, 명령 실패는 \`error\`에 표시한다. \`read <table>\`의 data는 \`{schema, table}\`이며 Key 열은 \`data.schema.primary_key\`, 행은 \`data.table.rows\`다. 숫자는 문자열 그대로 읽는다.

종료 코드 0은 성공이며 \`severity: warning\`만 있으면 0이다. 1은 검증 오류·미해결 충돌·포맷 필요, 2는 명령 실패다. 기존 오류 때문에 read가 1로 끝나도 data와 revision은 읽을 수 있다. 편집의 1은 미반영을 뜻하지 않는다. \`data.applied\`, \`changed\`, diagnostics를 확인하고 같은 요청을 무조건 재실행하지 않는다. Git 명령은 \`data.completed\`를 확인한다.

## 도메인 폴더

테이블·문서는 \`tables/<폴더>/<이름>.yaml\`, \`documents/<폴더>/<이름>.md\`로 분류하며 schemas/도 재귀적으로 읽는다. 테이블·문서 이름은 두 루트 전체에서 대소문자 무시 유일하다. read·rename·where-used·참조 주소에는 폴더를 넣지 않는다.

\`vibe folder list --json\`으로 폴더를 읽는다. 생성·이름 변경·이동·삭제는 \`vibe folder create/rename/move/delete\`, 리소스 이동은 \`vibe move table <이름> --folder <상대 폴더>\` 또는 \`vibe move document <이름> --folder <상대 폴더>\`를 쓴다. 쓰기는 \`--target base --expect-revision <revision>\`과 \`--dry-run\`을 사용한다. 최상위 목적지는 빈 문자열이다. 파일을 직접 옮기거나 참조를 수동 재작성하지 않는다. rename은 현재 폴더에서 이름만 바꾸며 move는 원문·공개 참조를 유지한다.

새 테이블은 table-create 입력의 선택적 folder 또는 edit의 --folder, 문서는 document create의 --folder로 목적지를 지정한다. 생략하면 최상위다.

## 편집

먼저 read에서 revision을 얻고, 요청 JSON 파일을 UTF-8로 만든다. PowerShell 5.1의 UTF-8 BOM도 허용한다. 요청 파일은 기획 원본과 구분한 임시 경로에 두고 커밋하지 않는다. Windows PowerShell 5.1에서는 이미 만든 JSON을 ConvertFrom-Json → ConvertTo-Json으로 다시 변환하면 배열 모양이 바뀔 수 있다. JSON 원문을 here-string으로 작성해 Out-File -LiteralPath <요청파일> -Encoding utf8로 저장한다.

\`edit --input\`은 아래 중 객체 하나, \`apply --input\`은 행 변경 객체 배열을 받는다.

\`\`\`json
{"op":"update","table":"items","key":"currency_gold","values":{"name":"골드"}}
\`\`\`
\`\`\`json
{"op":"create","table":"items","row":{"key":"new_item","name":"새 아이템"}}
\`\`\`
\`\`\`json
{"op":"delete","table":"items","key":"new_item"}
\`\`\`

\`\`\`sh
vibe edit --target base --input change.json --expect-revision <read의_revision> --json
vibe apply --target base --input changes.json --expect-revision <read의_revision> --json
vibe rename key items/currency_gold --target base --to currency_coin --expect-revision <read의_revision> --json
vibe where-used items/currency_coin --json
\`\`\`

rename은 key·table·column·schema·document·heading·tag 이름을 바꾸고 선언된 참조와 Markdown 링크 목적지를 함께 고친다. Key를 일반 update로 바꾸지 않는다. rename이 반환하는 본문 candidates는 자동 수정되지 않았으므로 사람에게 보고한다. where-used는 필요할 때 조회하는 기능이며 사전 실행 의무는 없다.

새 테이블: \`{"op":"table-create","table":"rewards","key":{"code":"key","label":"Key"}}\`.
열 추가: \`{"op":"column-add","table":"rewards","column":"amount","definition":{"type":"decimal","label":"수량"}}\`.
이 객체들도 edit에 전달한다. import는 inspect → plan → apply 순서로 원문과 매핑을 확인하고 사용한다. 이번 요청에 없는 구조·도메인 규칙을 만들지 않는다.

## 문서와 블록 편집

\`document list\`로 목록을, \`document read <name>\`으로 정확한 source와 블록·링크·revision을 읽는다. \`read 문서/제목/하위제목\`과 문단 바로 앞의 \`<!-- name: 이름표 -->\` 경로도 사용할 수 있다. 문서 이름만으로 전체 문서를 가리킨다. Markdown 링크의 목적지는 \`[가격](offers/bundle/price)\`처럼 기획 경로를 쓰며 공백이 있으면 \`[획득](<economy/재화 획득>)\`처럼 감싼다.

\`\`\`sh
vibe document list --json
vibe document read economy --json
vibe read economy/재화/획득 --target base --json
vibe document create economy --input economy.md --target base --expect-revision <읽은_revision> --dry-run --json
vibe document edit economy --input blocks.json --target base --expect-revision <document_read의_revision> --dry-run --json
vibe document delete economy --target base --expect-revision <읽은_revision> --dry-run --json
vibe document image diagram.png --target base --expect-revision <읽은_revision> --dry-run --json
vibe rename document economy --target base --to balance --expect-revision <읽은_revision> --json
vibe rename heading balance/재화 --target base --to 화폐 --expect-revision <읽은_revision> --json
vibe rename tag balance/화폐/설명 --target base --to 안내 --expect-revision <읽은_revision> --json
vibe where-used balance/화폐 --json
\`\`\`

기준안 문서 쓰기는 기획 생성 전에도 항상 \`--target base --expect-revision\`이 필수다. create/edit/delete/image는 먼저 --dry-run 결과를 확인하고 같은 입력·revision에서 --dry-run만 빼고 적용한다. create의 --input은 UTF-8 Markdown 파일이며 BOM도 원문 그대로 보존한다. edit의 --input은 다음과 같은 JSON 배열이다.

\`\`\`json
[{"op":"replace","block":1,"markdown":"고친 문단"},{"op":"insert","before":2,"markdown":"새 문단"},{"op":"delete","block":3}]
\`\`\`

block과 before는 0부터 시작하며 같은 읽기 revision의 블록 순번이다. source의 start/end 범위와 순번은 그 revision 안에서만 유효한 임시 편집 주소다. 파일에 ID로 저장하거나 공개 참조로 쓰거나 다음 revision에 재사용하지 않는다. 여러 작업도 원래 읽은 revision의 순번을 사용한다. 목록 전체·표 전체·인용 전체가 한 블록이다. 변경할 블록만 교체하고 전체 Markdown을 파싱 후 재직렬화하거나 정규화하지 않는다. BOM·빈 줄·들여쓰기·줄 끝 공백·CRLF·마지막 개행 유무 등 수정 범위 밖 바이트를 보존한다. 원문 블록은 명시적으로 원문을 편집하며 HTML을 실행하지 않는다. fmt도 문서 원문을 다시 쓰지 않는다.

제목·이름표와 참조된 이름을 바꿀 때는 rename을 사용한다. 일반 문구·코드의 이름 후보는 자동 치환하지 않는다. 이미지 추가 결과의 path는 \`assets/<파일명>\`이며 \`![설명](assets/<파일명>)\`으로 연결한다. 이미지는 \`documents/assets/\`에 저장되고 문서 본문은 별도의 블록 편집으로 연결한다. revision이 오래되면 document read로 새 원문과 요청을 비교하고 순번·범위를 다시 고른다.

## 문서 대안 편집

문서 대안도 core가 합친 결과로만 읽는다. 먼저 plan variant 입력에 documents: {"economy/재화": "## 재화\\n\\n대안 본문"}처럼 범위를 선언한다. 문서 전체 이름, 제목 경로 또는 이름표 문단만 선택할 수 있다. 목록·표 개별 선택과 범위 중첩은 지원하지 않는다. document_base_values는 core가 캡처하므로 입력에 쓰거나 갱신하지 않는다.

vibe document read economy --target review/A --json으로 합쳐진 블록·revision·selectedScopes를 읽는다. vibe document edit economy --target review/A --input blocks.json --expect-revision <읽은_revision> --dry-run --json으로 확인한 후 적용한다. 작업 순번은 그 합친 문서 revision 안에서만 유효하다. 대안 YAML만 바뀌며 기준안 Markdown은 확정 전까지 바뀌지 않는다. 선택한 제목·이름표는 유지하고 범위 밖 편집은 거절한다. plan read에서 이전 기준/현재 기준/대안을 확인하며, 사람이 선택한 경우에만 plan approve를 실행한다. 원문 출처를 우선순위로 자동 선택하지 않는다.

## 기획 단위와 대안

에이전트는 기획이 아직 없어도 기준안 읽기·쓰기 예시에 항상 \`--target base\`를 명시한다. CLI는 기획 생성 전의 기존 쓰기만 대상 생략을 허용한다. 기획이 있으면 edit/apply/rename/import apply에 \`--target base\`가 필수이며 다른 대상은 거절한다. 테이블 대안은 \`plan variant\`로 쓴다. 문서 대안의 편집은 아래 문서 대상 규칙도 따른다.

\`\`\`sh
vibe plan list --json
vibe plan read price-review --json
vibe plan create price-review --input definition.json --expect-revision <read의_revision> --dry-run --json
vibe plan create price-review --input definition.json --expect-revision <read의_revision> --json
vibe plan variant price-review/A --input variant-a.json --expect-revision <직전_revision> --dry-run --json
vibe plan variant price-review/A --input variant-a.json --expect-revision <직전_revision> --json
vibe plan variant price-review/B --input variant-b.json --expect-revision <직전_revision> --dry-run --json
vibe plan variant price-review/B --input variant-b.json --expect-revision <직전_revision> --json
vibe read offers/bundle --target price-review/A --json
vibe plan status price-review --to review --expect-revision <직전_revision> --dry-run --json
vibe plan status price-review --to review --expect-revision <직전_revision> --json
vibe plan status price-review --to draft --expect-revision <직전_revision> --dry-run --json
vibe plan status price-review --to draft --expect-revision <직전_revision> --json
\`\`\`

plan 쓰기도 먼저 --dry-run으로 파일·변경값·진단을 확인한 뒤 같은 입력·revision에서 --dry-run만 빼고 실행한다. 미리보기는 현재 revision과 applied: false, 빈 changed, 예정 파일 planned와 파일 내용 preview를 반환하며 파일을 바꾸지 않는다. plan list/read에는 --dry-run을 쓰지 않는다.

definition.json은 \`{"title":"가격 검토","status":"review","question":"어느 원문을 채택할까요?","sources":[]}\`다. 대상을 모르면 question과 원문 sources만 둔 review 기획을 만들고 대안을 만들지 않는다. 경로를 추측하거나 승인 대기를 가짜 B안으로 만들지 않는다.

variant-a.json은 \`{"set":{"offers/bundle/price":"00042.0000"},"sources":[]}\`처럼 작성한다. 행 추가는 \`add: {"offers/new": {"available":true}}\`, 행 삭제는 \`remove: ["offers/old"]\`다. 추가할 Key는 행 경로에서 얻으므로 본문에 다시 쓰지 않는다. 원래 file·sourceHash·sheet/cell 또는 page/path·raw를 sources에 보존하고 해석한 값과 구별한다. base_values와 base_missing은 core가 기록하므로 입력에 만들지 않는다.

A/B는 모두 기존 기준안 위의 대등한 변경분이다. \`read --target <plan>/<variant>\`가 core의 합친 값을 제공하며 에이전트가 직접 병합하지 않는다. \`plan read\`로 기준안·각 대안·진단을 비교하고 \`validate\`로 기준안과 각 대안을 모두 검증한다. 기준안 변경 경고는 이전 기준값·현재 기준값·대안과 함께 사람에게 보고한다.

확정은 사람이 선택한 경우에만 \`vibe plan approve price-review/A --expect-revision <직전_revision> --dry-run --json\`으로 미리 보고 같은 revision에서 --dry-run을 빼고 실행한다. 선택한 변경분을 기준안에 반영하고 다른 안과 출처는 보관한다. 확정된 기획은 다시 편집·합쳐 읽지 않으며 plan read로 보관 내용을, Git으로 과거 합친 상태를 확인한다. validate는 보관본의 문법을 검사하되 현재 기준안에 다시 적용하지 않는다. 이관 권한이나 검증 성공을 업무 내용의 자동 승인으로 해석하지 않는다. 기획 상태는 draft/review/approved이며 approved는 status --to로 만들지 않는다.

## 지켜야 할 것

- 숫자는 \`"0.005"\`, \`"12.5000"\`처럼 원문 문자열로 전달한다. Number/float로 변환하거나 표기를 정규화하지 않는다. 참조 칸은 대상 Key만 쓴다.
- 일반 enum·필수·범위 오류는 반영 뒤 진단한다. 선언된 삭제 보호, 잘못된 명령, 오래된 revision은 반영을 막는다.
- revision 불일치 시 다시 read하고 외부 변경과 내 요청을 비교한다. 새 revision만 끼워 같은 변경을 조용히 재실행하지 않는다. 중간 실패의 changed 목록을 확인하고 복구는 Git을 사용한다.
- 작업 후 \`vibe validate --json\`과 \`git diff\`로 요청 범위·숫자 원문·남은 오류를 확인한다. \`vibe fmt --check --json\`은 포맷 검사다. \`vibe fmt --json\`은 포맷 정리를 요청받았을 때만 실행한다.
- 커밋·push는 사용자가 요청한 경우에만 한다. \`status\`, \`save --reason\`, \`push\`, \`pull\`을 쓴다. 빈 사유와 force push는 금지다. save 및 pull --resolve의 revision은 read가 아니라 status에서 받는다.
- 수정한 파일, 검증 결과, 남은 본문 후보와 사람의 판단이 필요한 사항을 보고한다. 원문에서 알 수 없는 값은 추측해 채우지 않는다.

## Integer Keys and import order

- Key types are string, text or integer; values and path segments always remain strings. Integer values reject decimal points and exponent notation. Normal edits never normalize a Key: "01" and "1" are distinct identities.
- Only XLSX numeric cells with exact integer values are normalized during import ("1.0" to "1"). inspect.raw and source inspect preserve the original literal. Consult normalizedInteger/inferredTypes and the plan's normalizations/provenanceFile. imports/*.json stores the original coordinates, values and source hash. Text/date/fractional cells and CSV/TSV are outside this normalization.
- Use import inspect/plan/apply for automatic XLSX normalization. source inspect remains a raw reader, and ordinary apply does not normalize values.
- Imports append rows in source order. fmt, row edits and Key renames preserve file order; new rows append. Sorting in the table UI does not rewrite files.

## 이름에 /가 있는 경우

원문 제목·이름표·Key를 바꾸지 않는다. 주소의 구분자는 /이고 이름 안의 /는 ~1, ~는 ~0으로 바꾼 뒤 주소 앞에 ./를 붙인다. 예: Key 30/10 → ./items/30~110. 기존 items/30~110은 문자 그대로의 Key 30~110이다. document read와 folder list가 반환한 주소를 그대로 쓰는 것이 안전하다. where-used·rename 대상·기획 대안의 set/documents 주소도 동일하다. 대안에는 core가 반환한 canonical 주소를 쓴다.

apply JSON의 key와 ref 칸, rename --to 같은 새 이름 인자에는 이스케이프하지 않은 원문을 넣는다. Markdown 링크 목적지는 <...>로 감싸고 원문 %는 %25로 URI 인코딩한다. 전체 주소를 URI 디코딩해 구분자와 이름을 혼동하지 않는다. 폴더도 ./공격~1방어 형태로 만들고 CLI로 이동한다. 실제 디렉터리명과 .gitkeep의 원래 이름 기록을 수동으로 편집하지 않는다. 파일명인 테이블·스키마·문서의 Windows 안전 규칙은 유지한다.
`;
