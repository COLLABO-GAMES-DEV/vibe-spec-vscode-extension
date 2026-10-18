# 파일 포맷과 경로

[문서 지도](README.md) · [Key 결정](decisions.md#d03) · [경로 결정](decisions.md#d11)

## 기획 루트

VS Code 프로젝트 루트의 `.vibe-spec.json`에 선택한 기획 폴더를 저장한다. 레포 배치는 [d18](decisions.md#d18), 여러 작업 폴더 선택은 [d20](decisions.md#d20)을 따른다. 상대경로를 기본으로 하고, 기획 레포 자체를 열면 `"."`을 쓴다.

```json
{"planning_root": "./planning"}
```

```text
planning/
├── .gitattributes
├── .gitignore
├── AGENTS.md
├── .agents/skills/vibe-import/SKILL.md
├── schemas/
│   ├── items.yaml
│   └── shop-products.yaml
└── tables/
    ├── items.yaml
    └── shop-products.yaml
```

하위 폴더를 제외한 파일명에서 확장자를 뺀 이름이 테이블·스키마 이름이다. 같은 이름을 헤더에 한 번 더 저장하지 않는다. 테이블은 스키마 이름을 하나 지정한다. 이름 허용·중복 규칙은 [플랫폼 공통 파일 이름 결정](decisions.md#d16)을 따른다. 기획·대안은 사용 시 `plans/` 아래에 추가하며 [변경분 포맷](variants.md)을 따른다. 문서·그림 파일은 [문서 포맷](documents.md)을 따른다. 정수 정규화가 발생하면 `imports/`에 [출처 기록](import.md#xlsx-정수-정규화추론출처)을 추가한다.

개발용 내보내기 설정은 기획 루트의 `.vibe-spec.json`에 `"export_directory": "../development-export"`처럼 추가한다. 출력 경로·파생물 규칙은 [CLI](cli.md#개발용-내보내기)에 둔다.

## Key와 스키마

`primary_key`는 열 코드명 하나다. Key 열 타입은 string/text/integer이며 integer도 문자열로 저장한다. 그 열의 값은 비어 있지 않은 문자열이고 테이블 안에서 유일하며 생략/null을 허용하지 않는다. 이름이 반드시 key일 필요는 없다. 자연스러운 Key가 없는 연결 테이블도 사용자가 Key 열을 만든다. 추가 유일성은 선언할 수 있지만 복합 기본키는 두지 않는다.

`schemas/items.yaml` 예시:

```yaml
primary_key: key
columns:
  key:
    type: string
    label: "Key"
  source:
    type: text
    label: "Source"
  lore:
    type: text
    label: "Lore"
  note:
    type: text
    label: "Note"
```

열 mapping의 키가 코드명이며 label은 화면 표시명이다. 표시명 변경은 경로를 바꾸지 않는다. 지원 타입은 string, text, integer, decimal, boolean, enum, ref다. Key 외의 required·nullable·enum·범위·추가 unique는 스키마가 선언한 것만 검사한다.

화면에서 새로 만드는 열 코드명은 영문 소문자·숫자·밑줄이며 표시명에서 제안하고 사람이 수정한다. 기존 파일의 `Key`, `Source` 같은 코드명은 그대로 읽는다. 열의 표시 순서는 스키마 YAML mapping 순서이고 Key 열은 화면 왼쪽에 고정한다. 열 이동은 스키마만 바꾸며 행 파일을 다시 쓰지 않는다. 공유 스키마를 수정하면 이를 쓰는 모든 테이블에 적용되므로 화면에서 영향 범위를 알린다.

## 테이블 예시

실제 시트는 Key / Source / Lore / Note의 문자열 표다. Source는 한국어 아이템 이름 원문이고 숫자 데이터가 없다. 아래 행은 설명용이며 종류 열·접두어 규칙을 자동 생성하지 않는다.

`tables/items.yaml`:

```yaml
schema: items
rows:
  - key: "consumable_small_potion"
    source: "작은 회복약"
    lore: "여행자가 휴대하는 회복약."
    note: "초반 사용량 검토"
  - key: "currency_gold"
    source: "골드"
    lore: "왕국의 기본 재화."
    note: ""
```

참조는 ref 하나다. 스키마가 대상을 알면 칸에는 대상 Key만 쓴다. 다음 상점 예시는 실제 시트와 별개이며 사용자 스키마의 숫자·삭제 보호 선언을 보여준다.

`schemas/shop-products.yaml`:

```yaml
primary_key: sku
columns:
  sku:
    type: string
    label: "상품 코드"
  price_currency:
    type: ref
    table: items
    on_delete: restrict
    label: "결제 재화"
  price:
    type: decimal
    minimum: "0"
    label: "가격"
```

`tables/shop-products.yaml`:

```yaml
schema: shop-products
rows:
  - sku: "potion_bundle"
    price_currency: "currency_gold"
    price: "100.00"
```

`on_delete: restrict`를 생략하면 삭제를 사전 차단하지 않는다. 남은 참조가 끊겼는지는 [검증기](validation.md)가 보고한다.

## 직렬화와 숫자

- UTF-8·LF·2칸 들여쓰기 YAML을 쓴다. 중복 mapping key와 해석이 복잡한 alias·사용자 tag는 허용하지 않는다.
- 초기화한 기획 루트의 `.gitattributes`로 일반 텍스트의 checkout·저장소 줄바꿈을 LF로 고정한다. Markdown 원문 보존 예외는 [문서 계약](documents.md#범위와-원본)을 따른다. 기존 레포에도 같은 설정을 적용하고 CRLF 파일은 `fmt`로 한 번 정리한다. 읽기는 원문을 보존하며 새로 생성하거나 실제 변경해 기록하는 YAML의 줄바꿈은 LF다. 문자열 값의 `\\r\\n` 같은 이스케이프 표현은 바꾸지 않는다.
- 테이블당 파일 하나, 행은 파일의 기존 순서로 저장한다. 이관 시 원본 시트 순서로 추가하며 fmt·셀 편집·Key 이름 변경은 순서를 바꾸지 않는다. 일반 행 생성은 끝에 추가한다. Key는 행의 열에 한 번만 있으며 별도 행 주소 mapping에 복제하지 않는다.
- 한 칸은 한 줄의 스칼라다. 문자열은 큰따옴표로 쓰고 셀 내부 개행은 `\n`으로 표현한다. 한 행의 필드는 연속된 블록으로 둔다.
- 파서의 원문 정보를 유지해 변경 없는 유효 파일은 바이트 그대로 쓴다. 셀 수정은 그 줄만 바꾸며 전체 파일을 자동 재포맷하지 않는다. 행 추가·삭제와 스키마 변경은 한 줄 diff 조건의 예외다.
- integer/decimal도 문자열이다. `"900719925474099312345"`, `"+001.2300E+0002"`, `"-0.000"`을 그대로 보존한다. 일반 JSON·GUI·CLI 읽기/편집/내보내기에서는 Number로 바꾸거나 라이브러리 출력으로 덮어쓰지 않는다. 아래 XLSX 정수 이관만 예외다.
- 수치 범위와 숫자 열의 유일성은 decimal 라이브러리로 비교한다. 숫자 `"1"`과 `"1.0"`은 값이 같지만 일반 편집에서 저장 원문을 바꾸지 않는다. integer는 소수점·지수 표기를 검증 오류로 처리한다. Key의 식별·참조 비교는 타입과 무관하게 원문 문자열 기준이며 `"01"`과 `"1"`은 서로 다르다.

비교 라이브러리와 파일 쓰기는 [아키텍처](architecture.md)에 둔다.

## 경로형 참조

| 경로 | 대상 | 예시 |
| --- | --- | --- |
| {테이블} | 표 전체 | `items` |
| {테이블}/{키} | 행 | `items/currency_gold` |
| {테이블}/*/{열} | 모든 행의 열 | `shop-products/*/price_currency` |
| {테이블}/{키}/{열} | 셀 | `shop-products/potion_bundle/price` |
| {문서}/{제목}/{제목}/… | 문서 섹션 | `economy/재화/획득` |

- 테이블·스키마·문서 이름, Key, 열 코드명, 제목·이름표는 비어 있거나 /를 포함할 수 없다. / 이스케이프는 없다. 열 표시명에는 이 제약을 적용하지 않는다.
- 경로 첫 단계의 모호성을 피하려고 테이블명과 문서명은 서로 중복시키지 않는다. 스키마는 별도 디렉터리의 이름 공간을 쓴다.
- Key의 `*` 값은 열 경로와 겹치므로 예약한다. 행·열 경로의 단계 수와 뜻을 고정하고, 기능 확장은 뒤에 단계를 추가하는 방식으로만 한다.
- 참조와 Key는 대소문자를 구분한 원문으로 비교한다. 파일 이름 충돌 검사는 [결정](decisions.md#d16)에 따라 별도로 수행한다. 열 경로에는 표시명이 아니라 코드명을 쓴다.
- 전체 경로는 문서 링크처럼 대상이 정해지지 않은 곳에 쓴다. 대상 테이블이 스키마에 있는 ref 칸에는 Key만 쓴다.
- 이름 변경은 [rename](cli.md)으로 선언된 연결을 함께 수정한다.

## 문서 — 2단계 원칙

문서는 파일명으로 식별하며 [플랫폼 공통 파일 이름 결정](decisions.md#d16)을 동일하게 적용한다. Markdown 제목 계층을 경로로 쓰며 제목에는 파일명 제약을 확대하지 않는다. 이름 없는 문단은 보통 참조하지 않는다. 필요할 때만 바로 앞에 짧은 이름표를 붙인다. 예시 표기는 다음과 같으며 편집 세부 사항은 [문서 계약](documents.md)을 따른다.

`documents/economy.md`:

```markdown
# 재화
## 획득
[골드](items/currency_gold)는 기본 보상이다.

<!-- name: 초반보상 -->
첫 보상은 적게 시작한다.
```

섹션은 `economy/재화/획득`, 이름표 문단은 `economy/재화/획득/초반보상`으로 가리킨다. 같은 부모 아래 제목은 유일해야 한다. 이름표도 같은 부모의 제목·다른 이름표와 겹치지 않게 한다. 일반 본문은 자동으로 주소를 부여하지 않는다.

### XLSX 정수 이관 예외

[d23](decisions.md#d23)에 따라 XLSX **숫자 셀**의 원래 저장 문자열을 decimal 라이브러리로 정확히 판정한다. 값이 정수인 `"1.0"`, `"1e3"` 등은 이관 시 `"1"`, `"1000"`으로 저장한다. 이후 읽기·쓰기·편집·내보내기는 이 문자열을 그대로 쓴다. XLSX 텍스트 셀의 `"1.0"`, 소수 값, 날짜, CSV/TSV 원문과 일반 편집에는 이 예외를 적용하지 않는다. 원문 reader `source inspect`와 `import inspect.raw`도 바꾸지 않는다. 정규화 기록은 [이관 계약](import.md)의 provenance에 남긴다.

## 도메인 폴더

[d24](decisions.md#d24)에 따라 기존 루트를 유지하고 그 아래 상대 폴더를 도메인으로 쓴다. 예를 들어 `tables/경제/shop-products.yaml`과 `documents/경제/상점.md`는 사이드바의 같은 `경제` 폴더에 나타난다. `tables/items.yaml` 같은 기존 평면 파일은 최상위에 그대로 보인다. 중첩 도메인도 허용한다.

```text
planning/
├── schemas/shop-products.yaml
├── tables/경제/shop-products.yaml
├── documents/경제/상점.md
└── documents/assets/shop.png
```

schemas/도 재귀적으로 읽고 스키마 이름은 전체 schemas/ 아래에서 유일하다. 새 스키마는 기존처럼 schemas/에 생성하며, 공유 스키마는 테이블 이동 시 옮기지 않는다. 테이블·문서는 두 루트 전체를 합친 이름 공간에서 대소문자 무시 유일하다. 같은 이름의 파일을 다른 도메인으로 구분하지 않는다. `shop-products/bundle/price`나 `상점/가격` 같은 참조는 이동 전후 동일하다. rename은 현재 폴더에서 파일명만 바꾸고, move는 파일 원문을 그대로 옮긴다.

폴더명 각 단계에 Windows 안전 파일명 규칙을 적용한다. 같은 부모 아래 대소문자만 다른 폴더는 tables/와 documents/를 합쳐 중복으로 본다. 최상위 `assets`는 공용 이미지 저장소 때문에 예약한다. `/`는 폴더 경로 단계 구분자로만 쓰며 `.`·`..`·절대경로·역슬래시·심볼릭 링크로 관리 루트를 벗어나는 경로는 거절한다. 이름 오류에는 수정 제안을 제공한다.

폴더 생성은 tables/와 documents/ 아래 동일한 경로를 만들고 각 `.gitkeep`으로 빈 폴더도 Git에 남긴다. 기존 수동 하위 폴더는 표·문서가 한쪽에만 있어도 인식한다. 폴더 이름 변경/이동은 양쪽의 해당 하위 트리를 함께 옮긴다. 폴더 삭제는 양쪽 모두 비어 있을 때만 가능하며 `.gitkeep`만 예외로 친다. 관리하지 않는 파일이나 하위 폴더가 남아 있으면 삭제를 거절한다. 폴더 병합·덮어쓰기는 하지 않는다. 기존 리소스 rename과 마찬가지로 대소문자만 바꾸는 폴더 rename은 중간 이름을 거치도록 안내하고 직접 적용은 거절한다. 이동 대상에 관리하지 않는 파일이 있으면 자동 이동하지 않고 원인을 알린다.

폴더·빈 폴더 표시 파일도 revision과 Git 관리 대상이다. 잠금·revision 확인·파일별 교체·Git 복구 원칙은 유지한다. 문서 이동으로 Markdown을 재출력하지 않는다. `assets/<파일명>`은 문서 파일 위치에 상대적인 경로가 아니라 기존 documents/assets/를 가리키는 제품 이미지 경로이며, 하위 폴더에서도 동일하다. Markdown Git 속성은 `documents/**/*.md -text`로 하위 문서까지 포함한다.
