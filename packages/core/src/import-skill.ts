export const planningImportSkill: string = `---
name: vibe-import
description: CSV·TSV·XLSX와 Notion 내보내기 ZIP을 조사하고 구조·Key·타입을 제안해 vibe-spec 기획으로 일회성 이관할 때 사용한다. 원문·충돌·출처를 보존하며 지속 동기화는 하지 않는다.
---

# 기획 불러오기

기획 루트의 AGENTS.md와 이 문서를 읽고 설치된 vibe CLI를 사용한다.
이 문서의 위치는 기획 루트의 .agents/skills/vibe-import/SKILL.md다. Claude 등에서도 이 파일을 명시적으로 읽게 할 수 있다.
원문을 옮기는 권한과 기획 내용을 확정하는 판단을 구분한다. 원문 자체를 승인된 기획으로 간주하지 않는다.
조사 → 구조·Key·타입 제안 → 필요한 질문·결정 기록 → dry-run → 적용 → 검증 → 출처 보고 순서로 진행한다.

## 1. 조사

- 사용자 요청의 원본·대상·허용 범위를 확인한다. 이미 명확하게 승인된 범위는 재확인을 강제하지 않는다.
- 기획 루트에서 실행하거나 대상 명령에 --project <기획 루트>를 지정한다. vibe --help로 지원 명령을 확인한다.
- vibe read <기존 테이블 또는 경로> --target base --json으로 스키마·값·revision을 읽는다. 빈 프로젝트는 vibe validate --json의 revision을 사용한다. 기획 생성 전에도 기준안 읽기·쓰기에는 --target base를 명시한다.
- vibe source inspect <원본 파일> --json으로 CSV·TSV·XLSX·ZIP을 조사한다. file·sourceHash와 issues를 보존한다.
- 시트는 cells의 좌표·raw·formula·merges, 숨김 여부와 빈 영역을 함께 살핀다. 헤더 위치를 고정하거나 내부 빈칸을 압축하지 않는다.
- 숫자는 raw 문자열 그대로 다룬다. Number/float 변환·반올림·표기 정규화를 하지 않는다. 저장 원문·표시값·수식 캐시는 구별한다.
- Notion ZIP은 files·pages·databases와 ID 링크를 읽는다. DB_all 전체 CSV를 조사 대상으로 우선하고 부분 보기·중복 내보내기·자기 링크를 구별한다.
- 각 시트 영역과 페이지의 본문·표·DB 목록을 만든다. 출력이 잘린 요약만으로 조사 완료로 간주하지 않고, 미검토 범위는 따로 밝힌다.
- 연결된 본문·요약·표·DB가 같은 항목을 반복하면 양쪽 값과 단위·시점·구간 기준을 대조한다. 구조 승인 대기는 이 읽기 비교를 생략할 이유가 아니다. 같은 의미인지 불명확해도 양쪽 원문을 질문에 남긴다.
- 파일 경로·페이지 ID·링크 대상과 본문 문맥을 함께 보존한다. 지원하지 못하는 블록·관계·수식·병합은 누락시키지 말고 보고한다.
- 읽기 도구가 원문을 보장하지 못하면 해당 부분을 보류한다. 전용 파서·수식 계산기·지속 동기화 장치를 새로 만들지 않는다.

## 2. 구조·Key·타입 제안

- 표·문서 구분, 대상 테이블·열 코드명·표시명, 원본 위치의 매핑과 제외·변환 후보를 간단히 제시한다.
- 테이블마다 비어 있지 않고 유일한 문자열 Key 열 하나를 제안한다. 기존 Key를 존중하고 별도 ID·복합 Key를 임의 발급하지 않는다.
- 타입은 string/text/integer/decimal/boolean/enum/ref에서 고른다. integer·decimal 값도 문자열이며 ref 값은 대상 표의 Key다.
- 필수·범위·enum·참조·분류 규칙은 사용자 스키마나 명시적 결정에 근거한다. 이름 접두어나 특정 도메인 관례로 규칙을 만들지 않는다.
- 문서는 제목 구조를 제안하되 현재 CLI가 지원하지 않는 문서 쓰기를 파일 직접 편집으로 대신하지 않는다. 기획·대안은 아래 plan 명령만 쓴다.

## 3. 질문과 결정 기록

- 원문과 대상이 명확하고 승인 범위 안인 부분은 baseline으로 진행한다. 해석·새 Key 선택·새 구조 결정이 필요한 부분은 review로 분리한다.
- 빈칸을 추측해 채우거나 내용을 버리거나 값 불일치를 자동 해결하지 않는다. 새롭게 사람 판단이 필요한 쟁점만 질문한다.
- 출처 종류별 기준값 우선순위는 승인 전까지 제안이다. 원본 충돌은 A/B를 대칭으로 놓고 어느 쪽도 자동으로 기준값으로 삼지 않는다.
- 기존 기준값이 있으면 그 값을 유지하고 충돌 부분은 보류 표시한다. 기존 기준값과 충돌한 양쪽 원문·출처를 모두 보존한다.
- vibe plan list --json과 vibe plan read <name> --json으로 기존 질문·대안·비교를 읽는다. 문제마다 title, status: review, question, sources를 담은 definition JSON을 만들어 vibe plan create <name> --input <definition.json> --expect-revision <읽은 revision> --json으로 기록한다.
- 대상 경로가 미정이면 metadata만 있는 review 기획을 만든다. 임의 targetPath나 대안을 만들지 않는다. 실제로 서로 다른 원본값에만 대칭 A/B를 만들고, 해석 제안은 대안 하나, 구조 미정은 대안 없이 질문만 남길 수 있다. 보류·승인 대기를 가짜 B안으로 만들지 않는다.
- 대상이 확인되면 각 안을 {"set":{"<table>/<key>/<column>":"<값>"},"sources":[<출처>]}로 만들어 vibe plan variant <plan>/<variant> --input <variant.json> --expect-revision <직전 revision> --json으로 쓴다. 행 추가는 add의 행 경로와 Key를 제외한 행 객체, 행 삭제는 remove의 행 경로 배열이다. base_values/base_missing은 core가 기록한다.
- 각 sources에는 원본 file·sourceHash·sheet/cell 또는 page/path·raw를 그대로 보존한다. 단위·쉼표 등 해석 제안은 원문 raw와 분리하고 승인 전에 기준값에 반영하지 않는다. 원문 출처를 가공된 테이블의 위치로 바꾸지 않는다.
- 기획 파일의 sources 안 숫자 좌표도 "111"처럼 문자열로 전달한다. 숫자 입력은 자동 변환되지 않고 거절된다. 원본 조사 JSON의 좌표를 옮기는 표기 변경은 출처에 알리고 원래 조사 파일은 보존한다.
- vibe read <경로> --target <plan>/<variant> --json으로 core가 합친 결과만 읽는다. 에이전트가 기준안과 변경분을 직접 병합하지 않는다. A/B는 모두 같은 기준안 위의 대등한 변경분이다.
- 상태 변경은 vibe plan status <name> --to draft 또는 --to review --expect-revision <직전 revision> --json으로 한다. 사용자가 특정 안을 확정한 경우에만 vibe plan approve <plan>/<variant> --expect-revision <직전 revision> --json으로 기준안에 반영한다. 조사·이관 권한과 검증 성공은 업무 내용의 자동 승인이 아니다.

~~~json
{"title":"원본 간 값 충돌","status":"review","question":"어느 값을 채택할까요?",
  "sources":[
    {"file":"<원본 A>","sourceHash":"<hash A>","sheet":"<시트>","cell":"<셀>","raw":"<원문 A>"},
    {"file":"<원본 B ZIP>","sourceHash":"<hash B>","page":"<페이지 ID>","path":"<ZIP 내부 경로>","raw":"<원문 B>"}
  ]}
~~~

## 4. Dry-run

- CLI 입력 JSON은 임시 파일로 만든다. 결정 목록·출처 기록을 edit/apply 입력으로 보내지 않는다.
- 일반 변경은 vibe edit --target base --dry-run --input <객체.json> --expect-revision <읽은 revision> --json으로 미리 본다.
- 여러 행 변경은 vibe apply --target base --dry-run --input <배열.json> --expect-revision <읽은 revision> --json을 쓴다. 구조 변경은 edit로 다룬다.
- 질문·대안 쓰기도 적용 전에 미리 본다. vibe plan create <name> --input <definition.json> --expect-revision <읽은 revision> --dry-run --json, vibe plan variant <plan>/<variant> --input <variant.json> --expect-revision <직전 revision> --dry-run --json을 쓴다. 한 단계의 미리보기를 확인하고 적용한 다음, 반환 revision으로 다음 단계를 미리 본다.
- 상태 변경은 vibe plan status <name> --to review --expect-revision <직전 revision> --dry-run --json으로 미리 본다. draft도 같다. 사람이 확정한 안은 vibe plan approve <plan>/<variant> --expect-revision <직전 revision> --dry-run --json으로 기준안 반영을 미리 본다. plan list/read에는 --dry-run을 쓰지 않는다.
- plan 쓰기의 미리보기는 applied: false, 빈 changed, 예정 파일 planned와 파일 내용 preview를 반환한다. 파일·revision은 그대로이며 diagnostics는 예정 상태의 검증이다. 대안 비교는 plan read와 read --target을 쓴다.
- 단순 표 이관은 기존 경로를 유지한다. vibe import inspect <파일> --json → vibe import plan <파일> --mapping <매핑.json> --json으로 미리 본다.
- 매핑의 선택적 folder는 tables/ 아래 상대 목적지이며 생략하면 최상위다. 테이블·문서 이름은 폴더와 무관하게 전체에서 대소문자 무시 유일하고 참조 주소에는 폴더를 넣지 않는다.
- 매핑에는 원본 시트·헤더·데이터 시작 위치, 열 대응, 대상 스키마·Key와 숫자 표현 선택을 담는다. 저장값과 표시값이 다르면 차이를 보여준다.
- import plan의 반환 data를 적용 입력으로 보관한다. 이 plan은 표 이관 미리보기이며 기획 A/B 기능이 아니다.
- 대상 파일·변경값·제외·미지원 부분·진단을 원문과 대조한다. 지원 명령이 없으면 설치 문제와 보류 범위를 보고하며 YAML 직접 쓰기로 우회하지 않는다.

### Markdown 문서 이관

- documents/**/<이름>.md의 이름은 원본 페이지 이름에서 제안하고 기존 테이블·문서와 충돌하는지 확인한다. Notion ID는 출처 기록에만 남긴다.
- 분류할 폴더는 document create --folder <상대 폴더>로 지정한다. 기존 리소스는 vibe move table|document <이름> --folder <상대 폴더> --target base --expect-revision <revision> --dry-run으로 확인한 뒤 이동하며 원문·참조를 수동 재작성하지 않는다.
- 문서는 원문을 그대로 입력한다. vibe document create <이름> --input <원문.md> --target base --expect-revision <읽은 revision> --dry-run --json으로 미리 본다. 기존 문서는 document read의 블록 순번과 같은 revision으로 document edit를 사용한다. 전체 Markdown 재직렬화는 금지한다.
- 이미지도 vibe document image <파일> --target base --expect-revision <읽은 revision> --dry-run --json으로 확인한다. 적용 뒤 반환된 assets 경로만 링크에 쓴다. 외부 이미지를 임의로 다운로드하지 않는다.
- 원본 페이지와 이미지의 대응이 확실할 때만 링크 목적지 구간을 바꾼다. 링크 라벨·본문·빈 줄은 보존하고 바뀐 구간과 원본 해시를 기록한다. 자기 페이지 링크를 추측한 섹션으로 바꾸지 않는다.
- 깨진 링크, 금지된 제목 이름, 원문 모드로만 가능한 구문은 삭제·자동 복구하지 않는다. 원문이 있는 문서는 그대로 보존하되 해당 경로·출처·질문을 컨펌 전 기획으로 기록한다. 변환 불가를 이유로 페이지나 이미지를 누락하지 않는다.

## 5. 적용

- 승인된 범위와 해결된 결정만 적용한다. review가 남은 부분은 보류하고 독립적으로 문제없는 부분은 진행한다.
- 기획 데이터 쓰기는 항상 CLI로 한다. 확인한 edit/apply 또는 plan create/variant/status/approve 요청에서 --dry-run만 빼고 같은 입력·--expect-revision으로 실행한다. approve는 사람의 확정 결정이 있을 때만 실행한다.
- 단순 표는 vibe import apply --target base --input <이관 plan.json> --expect-revision <plan의 revision> --json으로 적용한다. 기존 Importer의 매핑·원본 해시·revision 검사를 우회하지 않는다. edit/apply/rename/import apply는 대안 target을 받지 않으며 대안은 plan variant로만 쓴다.
- revision 불일치·원본 변경 시 다시 조사하고 변경 차이를 비교한다. 새 revision만 넣어 같은 요청을 조용히 재실행하지 않는다.
- 종료 코드만으로 반영 여부를 판단하지 않는다. data.applied·changed·diagnostics와 반환 revision을 확인하고 부분 실패를 중복 적용하지 않는다.
- 복구가 필요하면 변경 파일을 확인해 Git으로 처리한다. 다중 파일 원자성이나 자동 복구를 약속하지 않는다. commit·push는 별도 요청이 있어야 한다.

## 6. 검증과 출처 보고

- vibe validate --json, vibe read <대상 경로> --target base --json, git diff로 값·Key·참조·숫자 원문과 요청 범위를 확인한다. 대안은 --target <plan>/<variant>로 읽는다. validate는 기준안과 각 미확정 대안을 모두 검사하며 severity: warning만 있으면 종료 코드 0이다. 확정된 기획은 보관본의 문법만 검사하고 현재 기준안에 다시 합치지 않는다. plan read로 보관 내용, Git으로 과거 합친 결과를 확인한다. 경고도 원문·현재 기준값과 대조해 보고한다.
- 원본의 빈칸·누락·수식·병합·제외 부분이 어디에 남았는지 대조한다. 기존 오류와 이번 변경의 오류를 구별해 보고한다.
- 적용한 값마다 원본 file·sourceHash, sheet/cell 또는 page/path, raw → 대상 path·appliedRevision의 JSON 기록을 최소한 제시한다.
- 전체 조사 JSON은 한 곳에 보존하고 결정 목록에는 문제값·좌표·필요한 짧은 문맥만 넣는다. 동일한 시트 전체를 각 질문의 raw에 반복 복제하지 않는다.
- appliedRevision은 성공한 적용 응답에서 가져온다. 미적용 항목에 revision을 꾸며 넣지 말고 보류 사유와 양쪽 원문을 남긴다.

~~~json
{"source":{"file":"<원본 파일>","sourceHash":"<hash>","sheet":"<시트>","cell":"<셀>","raw":"<원문>"},"target":{"path":"<확인된 대상 경로>","appliedRevision":"<적용 응답 revision>"}}
~~~

최종 보고에 적용 파일·검증 결과·출처 기록·남은 review 질문과 미지원 범위를 적는다. 일회성 이관 뒤의 원본은 기획 레포이며 재불러오기로 자동 덮어쓰지 않는다.

## XLSX 정수 예외

XLSX 숫자 셀의 값이 정확한 정수이면 이관값은 정수 문자열이다(1.0 → 1). 텍스트 "1.0", 소수·날짜와 CSV/TSV는 정규화하지 않는다. inspect의 raw는 원문이며 normalizedInteger는 이관 후보다. 최종 값이 모두 정수 문법인 열에는 integer를 제안하고 Key도 integer를 사용할 수 있다. 원문/변환값은 plan.normalizations와 imports/*.json provenance로 확인한다. 자동 정규화와 출처 기록에는 import inspect/plan/apply를 사용한다. source inspect는 원문 조사이고 일반 apply는 정규화하지 않는다. 일반 편집에서는 이 변환을 반복하지 않는다. 이관 행은 시트 순서이며 fmt와 편집은 파일 순서를 보존한다.
`;
