# CLI와 AGENTS.md

[문서 지도](README.md) · [이름 변경 결정](decisions.md#d12)

## 명령

공통으로 `--project <기획 폴더>`와 `--json`을 제공한다. JSON은 결과·진단·현재 파일 revision을 포함하며 읽기·편집 대상은 최상위 `target`에 표시한다. 숫자는 항상 문자열이다. 기준안 생성·수정·삭제는 edit로 묶는다.

| 명령 | 역할 |
| --- | --- |
| `vibe init <folder>` | 빈 기획 폴더·설정·AGENTS 안내 생성 |
| `vibe read <table-or-path> [--target base\|<plan>/<variant>]` | 기준안 또는 core가 합친 대안의 스키마·데이터·revision 조회; 생략 시 base |
| `vibe plan list` | 기획 이름·상태·대안 목록 |
| `vibe plan read <name>` | 기획 메타데이터·대안·기준안과의 비교·진단 |
| `vibe plan create <name> --input <definition-json> --expect-revision <revision> [--dry-run]` | 기획 생성; 대안 없는 질문도 기록 가능 |
| `vibe plan variant <plan>/<variant> --input <variant-json> --expect-revision <revision> [--dry-run]` | 대안 변경분과 출처 저장 |
| `vibe plan status <name> --to draft\|review --expect-revision <revision> [--dry-run]` | 기획중·검토 상태 변경 |
| `vibe plan approve <plan>/<variant> --expect-revision <revision> [--dry-run]` | 사람이 선택한 안을 기준안에 반영하고 확정; 다른 안은 보관 |
| `vibe export [--output <folder>]` | 스키마 요약·전체 행을 테이블별 마크다운 파일로 내보내기 |
| `vibe edit --target base --input <file> [--dry-run]` | 사용자 스키마·테이블·행·칸 생성/수정/삭제 |
| `vibe apply --target base --input <file> [--dry-run]` | 행 변경 배열을 한 번에 적용 |
| `vibe fmt [--check]` | 명시적 포맷 정리 또는 변경 필요 여부 확인 |
| `vibe validate` | 기준안과 각 대안을 모두 검증; 오류 시 실패 종료, 경고만 있으면 성공 |
| `vibe source inspect <file>` | 원본 시트·Notion ZIP의 문자열·좌표·출처 메타데이터 조사 |
| `vibe import inspect <file>` | CSV/TSV/XLSX의 시트·좌표·원문·경고 조사 |
| `vibe import plan <file> --mapping <file>` | 대상 파일·매핑·이관 결과 미리보기 |
| `vibe import apply --target base --input <plan-file>` | 확인한 이관 계획을 revision·원본 해시 검사 후 적용 |
| `vibe rename <kind> <path-or-name> --target base --to <name>` | 구조화된 연결을 함께 이름 변경 |
| `vibe where-used <path>` | 기획 레포 안의 사용처·본문 후보 조회 |
| `vibe status` | 저장·전송 상태와 충돌·Git revision 조회 |
| `vibe save --reason <text>` | 기획 파일 변경을 사유와 함께 커밋 |
| `vibe push` | 저장한 변경 올리기 |
| `vibe pull` | 원격 변경 병합, 충돌·병합 후 진단 반환 |

파일을 바꾸는 edit/apply/import apply/rename/plan은 읽은 `--expect-revision`을 받는다. 실제 적용 여부와 검증 진단을 함께 반환한다. `validate`의 실패를 파일을 수정하지 않았다는 뜻으로 혼동하지 않게 한다. 데이터 편집·이관·rename이 몰래 커밋하거나 push하지 않는다.

edit/apply/rename/import apply는 기획 파일이 하나라도 있으면 `--target base`를 반드시 받는다. 기획 생성 전에는 이전 CLI와의 호환을 위해 생략을 허용한다. 에이전트 안내와 예시는 생성 전에도 명시한다. 다른 target은 거절하며 대안 쓰기는 `plan variant`로 한다. read의 target은 `base` 또는 정확한 `<plan>/<variant>`만 허용한다. 잘못된 경로를 기준안으로 해석하지 않는다.

JSON 응답의 기존 `data` 모양은 유지한다. 읽기와 기준안 쓰기는 `target: "base"` 또는 `"<plan>/<variant>"`, 기획 메타데이터 작업은 `target: "<name>"`을 반환한다. 일반 출력도 대상을 표시한다. 종료 코드 0은 성공(경고 포함), 1은 검증 오류·충돌·포맷 필요, 2는 명령 실패다. 경고는 `severity: "warning"`이며 오류는 이 필드가 없다.

## 기획과 대안 예시

definition.json:

```json
{"title":"가격 원문 검토","status":"review","question":"어느 값을 채택할까요?","sources":[{"file":"prices.csv","sourceHash":"<원본 hash>","sheet":"prices","cell":"B2","raw":"00042.0000"}]}
```

variant-a.json:

```json
{"set":{"offers/bundle/price":"00042.0000"},"sources":[{"file":"prices.csv","sourceHash":"<원본 hash>","sheet":"prices","cell":"B2","raw":"00042.0000"}]}
```

```text
vibe read offers --target base --json
vibe plan create price-review --input definition.json --expect-revision <읽은 revision> --dry-run --json
vibe plan create price-review --input definition.json --expect-revision <읽은 revision> --json
vibe plan variant price-review/A --input variant-a.json --expect-revision <직전 revision> --dry-run --json
vibe plan variant price-review/A --input variant-a.json --expect-revision <직전 revision> --json
vibe plan variant price-review/B --input variant-b.json --expect-revision <직전 revision> --dry-run --json
vibe plan variant price-review/B --input variant-b.json --expect-revision <직전 revision> --json
vibe plan list --json
vibe plan read price-review --json
vibe read offers/bundle --target price-review/A --json
vibe plan status price-review --to review --expect-revision <직전 revision> --dry-run --json
vibe plan status price-review --to draft --expect-revision <직전 revision> --dry-run --json
vibe validate --json
```

대안은 `set`의 셀 경로와 값, `add`의 행 경로와 Key를 제외한 행 객체, `remove`의 행 경로 배열, 선택적인 `sources` 배열을 받는다. 추가할 Key는 행 경로에서 얻는다. `base_values`와 `base_missing`은 core가 기록하므로 CLI 입력에 넣지 않는다. 숫자는 JSON number가 아닌 원문 문자열이다. 원본 file·sourceHash·sheet/cell 또는 page/path·raw는 sources에 보존한다. 가공한 값이나 대상 경로로 원래 출처를 대체하지 않는다.

대상을 모르는 질문은 위 definition만으로 review 기획을 만들고 대안 없이 남긴다. 대상 경로·새 Key·가짜 B안을 추측해 만들지 않는다. 실제 충돌은 A/B를 같은 기준안 위의 대등한 변경분으로 보관한다. 에이전트는 `read --target`의 core 결과를 읽으며 직접 합치지 않는다. 비쟁점 기준안 변경은 대안에 상속되고, 덮어쓴 기준값의 변경은 경고로 보인다. validate는 기준안과 모든 합친 대안의 오류를 검사한다.

사용자가 특정 안을 확정했을 때만 `vibe plan approve price-review/A --expect-revision <직전 revision> --dry-run --json`으로 미리 본다. plan 쓰기는 예정 파일·변경값·진단을 확인한 뒤 같은 입력·revision에서 --dry-run만 빼고 실행한다. 선택된 변경분을 기준안에 반영하고 approved 및 selected를 기록하며 다른 안과 출처는 보관한다. 확정된 기획은 다시 편집·합쳐 읽지 않으며 `plan read`로 보관 내용을, Git으로 과거 합친 상태를 확인한다. validate는 보관본의 문법을 검사하되 현재 기준안에 다시 적용하지 않는다. 이관 권한이나 검증 성공은 업무 내용의 자동 승인이 아니다. `plan status --to approved`는 지원하지 않는다. 원문 이관의 기존 `import inspect/plan/apply` 흐름은 그대로이며 `import plan`은 A/B 기획 생성 명령이 아니다.

## 구조 편집과 저장 예시

`edit`는 다음 중 한 객체를 받는다. 기존 행 편집은 `create`(row), `update`(key, values), `delete`(key)이며 `apply`는 이 행 변경들의 배열을 받는다. 열·테이블 작업도 core의 같은 잠금·revision·검증 경로를 사용한다.

```json
{"op":"table-create","table":"quests","key":{"code":"key","label":"퀘스트 코드"}}
```

```json
{"op":"column-add","table":"quests","column":"reward","definition":{"type":"ref","table":"items","label":"보상","required":true},"position":{"anchor":"key","side":"after"}}
```

나머지는 `column-update`(table, column, changes), `column-delete`(table, column), `column-move`(table, column, position), `table-delete`(table)다. 코드명 변경은 아래 rename을 사용한다. 구조 변경의 데이터 보존과 삭제 규칙은 [익스텐션](extension.md#행열테이블-관리)에 둔다.

```text
vibe status --json
vibe save --reason "보상 구성 변경" --expect-revision <status의 revision> --json
vibe push --json
vibe pull --json
vibe pull --resolve choices.json --expect-revision <status의 revision> --json
```

충돌 선택 파일은 `[{"file":"tables/items.yaml","key":"currency_gold","choice":"ours"}]`처럼 작성한다. choice는 base/ours/theirs이고 파일 충돌에서는 key를 생략한다. 모든 충돌의 선택을 받아 병합을 완료한다. Git 상태 revision은 파일 편집용 read revision과 다르다. save의 revision은 선택 사항이며 지정하면 검사한다. resolve에는 필수다.

관리 파일은 기획 루트의 `schemas/*.yaml`, `tables/*.yaml`, `plans/<name>/*.yaml`, `AGENTS.md`, `.agents/skills/vibe-import/SKILL.md`, `.gitignore`, `.gitattributes`, `.vibe-spec.json`이다. save는 이 파일만 커밋하며 다른 staged 파일은 보존한다. Git 작업의 `data.completed`와 진단을 함께 확인한다. 병합 완료 뒤 깨진 참조가 있으면 이미 병합했어도 종료 코드가 1이다. 네트워크·인증 실패는 명령 오류이며 로컬 저장은 남는다.

## rename과 where-used

rename의 종류는 table, key, column, schema와 [문서 명령](documents.md#화면과-cli)의 document, heading, tag다. 예:

```text
vibe rename key items/currency_gold --target base --to currency_coin --expect-revision <revision>
vibe rename column "shop-products/*/price_currency" --target base --to currency --expect-revision <revision>
```

- 잠금 안에서 변경할 파일을 계산하고 기준안·모든 대안에 한 번의 명령으로 적용한다. 여러 파일을 원자적으로 바꾼다는 뜻은 아니다.
- Key 변경은 대상 표의 Key 값과 선언된 ref 칸을, 테이블 변경은 파일 이름과 스키마의 대상 표·전체 경로를 고친다.
- 열 코드명 변경은 스키마 선언, 해당 열을 쓰는 표, primary_key 지정, 열/셀 경로를 함께 고친다. 공유 스키마의 영향도 포함한다. label 변경은 경로 변경이 아니다.
- 스키마 이름 변경은 파일과 테이블의 schema 지정에 반영한다. 문서·제목 변경은 구조화된 문서 링크의 경로를 고친다.
- A/B의 변경 주소와 기준값 주소, 참조 열을 덮어쓰는 변경분의 Key 값도 스키마에 따라 갱신한다. 접두어 문자열 치환이 아니라 경로 단계와 참조 선언으로 대상을 찾는다.
- 본문·메모에 그냥 적힌 이름은 수정하지 않고 파일·위치·주변 문구를 후보로 반환한다. where-used는 같은 조회를 별도로 제공하며 실행 의무는 없다.
- 다른 브랜치와 과거 커밋은 건드리지 않는다. 실패·중간 적용의 복구는 [Git 기반 절차](architecture.md)에 따른다.
- 테이블·스키마의 대소문자만 바꾸는 이름 변경은 중간 이름으로 변경하고 저장한 뒤 최종 이름으로 변경한다. 대소문자를 무시하는 파일 시스템과 Git 인덱스가 다른 이름을 보지 않게 하기 위한 절차이며, 거절 메시지에 중간 이름을 제안한다.

## 개발용 내보내기

[d17](decisions.md#d17)에 따라 출력 위치는 `--output` → 기획 루트 `.vibe-spec.json`의 `export_directory` → `.vibe-spec-export` 순으로 고른다. 상대 경로는 기획 루트 기준이다. 전용 출력 폴더의 `.gitignore`로 파생물을 제외하고 YAML 원본은 수정하지 않는다. 같은 프로젝트에서 생성한 마크다운만 교체·정리하며 일반 파일은 덮어쓰지 않는다.

파일 머리에 원본 revision·스키마·검증 오류 수·이스케이프 방식을 적는다. `|`와 Markdown/HTML 특수문자는 숫자 HTML 엔티티, 줄바꿈은 `<br>`로 표현하며 숫자와 참조 Key를 변환하지 않는다. 정확한 값과 비어 있음/null/누락의 구분은 `read --json`으로 읽는다. 일반 값 오류가 있으면 생성 결과와 진단을 함께 반환한다. 읽을 수 없는 구조는 먼저 고치게 한다. 내보내기는 전달 태그 생성·확정·push를 하지 않는다.

## AGENTS.md에 넣을 규칙

1. 기획 루트와 설치된 CLI 사용법을 읽고, read로 값·스키마·revision을 확인한다. 기준안은 기획 생성 전에도 `--target base`를 명시한다.
2. 일반 편집은 edit, 이름 변경은 rename, 대안 쓰기는 plan variant를 쓴다. where-used는 조사 필요 시 사용하며 사전 확인 의무가 아니다.
3. 숫자는 원문 문자열로 전달한다. 선언되지 않은 도메인 규칙을 추가하지 않는다.
4. 결과는 validate와 diff로 확인하고, 수정된 파일·오류·남은 본문 후보를 보고한다. 커밋·push는 사용자 지시가 있을 때 한다.

기획·대안은 위의 작은 plan 명령으로 다룬다. core의 합친 결과를 읽고 에이전트가 직접 합치지 않는다. 대상 미정 질문은 출처를 보존한 metadata-only review 기획으로 남길 수 있다. 업무 승인과 확정은 사람의 결정에 따르며 전달 태그·시뮬레이션·추천 명령은 추가하지 않는다.

`edit/apply`와 `plan create/variant/status/approve`의 `--dry-run`은 `applied: false`, 빈 changed, 예정 파일 planned와 파일 내용 preview를 반환한다. 파일을 바꾸지 않고 revision은 현재 값이며 diagnostics는 예정 상태의 검증 결과다. plan list/read의 --dry-run은 거절한다. [이관 스킬·출처 기록](import.md#최소-원본-도구와-에이전트-스킬)을 따른다.

문서 블록 읽기·쓰기와 AGENTS.md의 원문 보존 지침은 [문서 CLI 계약](documents.md#화면과-cli)을 따른다.

## 폴더 관리

`vibe folder list/create/rename/move/delete`, `vibe move <table|document> <name> --folder <상대 폴더>`를 제공한다. 최상위는 빈 문자열이다. 쓰기는 `--target base --expect-revision`과 `--dry-run`을 사용하며 결과에 변경 파일·revision·검증을 반환한다. table-create와 document create는 선택적 `--folder`를 받고 기본은 기존 최상위다. read·rename·where-used의 공개 참조 주소에는 폴더를 쓰지 않는다. AGENTS.md도 이 구분을 안내한다.

이관 mapping의 선택적 `folder`는 표의 목적지이며 기존 mapping은 최상위로 적용한다. 개발용 Markdown 내보내기는 테이블의 도메인 하위 폴더를 출력 폴더에도 보존하고, 파일 내 테이블명·ref 값은 그대로 쓴다.

## 문서 대안 대상

[문서 대안](document-variants.md)은 `plan variant`의 `documents` 경로→Markdown 입력으로 범위를 선언한다. `document read <name> --target <plan>/<variant>`로 core가 합친 문서를 읽고, 그 블록 순번·revision으로 `document edit <name> --target <plan>/<variant> --input <operations.json> --expect-revision <revision> --dry-run`을 실행한다. 범위 밖 편집은 거절한다. 과거 기준값은 core가 기록한다. 확정은 기존 `plan approve`만 사용한다.

이름 안에 `/`가 있으면 [확장 주소](format.md#확장-주소)를 쓴다. `vibe read "./items/30~110" --json`은 원문 Key `30/10`을 읽는다. apply JSON의 `key`·ref 값·rename의 `--to`는 원문이며 주소만 이스케이프한다. `folder list`·`document read`가 반환한 주소를 그대로 사용한다.
