export const planningImportSkill: string = `---
name: vibe-import
description: CSV·TSV·XLSX와 Notion ZIP 원문을 조사하고 구조·Key·타입을 제안해 일회성 이관한다. 원문·충돌·출처를 보존한다.
---

# 기획 불러오기

기획 루트의 AGENTS.md와 이 문서를 읽고 설치된 CLI를 사용한다. Claude Code도 같은 문서를 읽는다.
조사 → 구조 제안 → 필요한 질문 → dry-run → 적용 → 검증·출처 보고 순서다. 이미 승인된 범위는 재확인하지 않는다.

## 조사와 구조 제안

- vibe source inspect <file> --json으로 원문을 읽는다. CSV/TSV/XLSX의 좌표·raw·formula·merges·서식·숨김·issues·sourceHash를 함께 보존한다. Number/float/Date 변환으로 원문을 복원하지 않는다.
- Notion ZIP은 원본 파일과 모든 페이지·이미지를 보존한다. 파일명 끝 32자리 ID로 링크를 연결하고 데이터베이스는 같은 ID의 _all.csv를 우선하되 다른 원본도 버리지 않는다. 외부 이미지를 임의로 받지 않는다.
- 원본 표마다 헤더 범위·Key·열 대응·타입을 제안한다. 빈/중복 Key, 여러 표, 병합 빈칸, 수식, 날짜, 불일치를 먼저 알린다. 병합 빈칸 채움·수식 재계산·추측값·미승인 합성 Key는 금지다.
- 같은 시트의 여러 표는 같은 도메인 폴더에 둘 수 있다. 이름은 프로젝트 전체에서 유일하며 참조 주소에는 폴더를 넣지 않는다.
- 원문끼리 다른 값, 철자 통합, 해석·제외·최종본 판단은 사람이 결정한다. 양쪽 값과 출처를 일반 문서의 확인 질문으로 남긴다. 미결 질문이 있어도 독립적으로 승인된 부분은 진행한다.
- 전용 plan/variant/status/approve 기능은 없다. 비교가 필요하면 표·문서를 복제하거나 문서의 A/B 제목 아래 출처별 원문을 둔다. 이관 권한이나 검증 성공을 내용의 자동 승인으로 해석하지 않는다. 옛 plans/ 파일은 삭제하거나 합치지 않는다.

## 미리보기와 적용

- vibe validate --json 또는 read로 현재 revision을 받는다. 모든 쓰기는 --expect-revision을 쓴다. --target base는 이전 스크립트 호환용이고 필요하지 않다.
- 단순 표: import inspect <file> → import plan <file> --mapping <mapping.json> → import apply --input <plan.json> --expect-revision <revision>. import plan의 data와 진단을 원문 대조한 뒤 적용한다. 기존 importer의 원본 해시·revision 검사를 우회하지 않는다.
- 새 표·스키마와 열은 edit의 table-create/column-add로 만든다. 행은 edit/apply의 create/update/delete를 쓴다. 입력 JSON은 임시 파일로 준비한다. 먼저 --dry-run --json으로 예정 파일·내용·진단을 확인하고, 같은 입력과 revision에서 --dry-run만 빼고 적용한다.
- 복제: duplicate table|document <name> --to <new-name> --expect-revision <revision> --dry-run --json. 표는 독립 스키마를 갖고, 참조·링크 대상은 원본과 같다. 복제본을 최종본으로 임의 선택하지 않는다.
- 문서: document create <name> --input <source.md> --folder <domain> --expect-revision <revision> --dry-run --json. 원문 Markdown을 유지한다. 기존 문서는 document read의 같은 revision 블록 순번으로 document edit한다. 전체 재직렬화는 금지다.
- 이미지: document image <file> --expect-revision <revision> --dry-run --json. 적용 뒤 반환한 assets 경로만 사용한다. 원본 대응이 명확한 링크 목적지만 수정하고 라벨·본문·공백은 보존한다. 자기 페이지 링크를 추측한 섹션으로 바꾸지 않는다.
- 깨진 링크·미지원 요소도 버리지 않는다. 원문 모드로 보존하고 출처·질문을 일반 확인 문서에 남긴다.
- revision 불일치나 원본 변경 시 다시 읽고 차이를 비교한다. 새 revision만 넣어 재시도하지 않는다. data.applied·changed·diagnostics로 반영 여부를 확인하며 중간 실패 복구는 Git이다. commit/push는 별도 요청이 있을 때만 한다.

## 검증과 출처

- validate --json, fmt --check --json, read --json, git diff로 값·Key·참조·원문과 범위를 대조한다. 기존 오류와 새 오류를 구분한다. fmt는 포맷 변경을 요청받았을 때만 실행한다.
- 값마다 file·sourceHash·sheet/cell 또는 page/path·raw·대상 경로·appliedRevision을 기록한다. 원문 전체는 한 곳에 보존하고 질문에는 필요한 값과 짧은 문맥만 둔다. 미적용 항목에 revision을 꾸며 넣지 않는다.
- 빠진 페이지·이미지·셀·빈칸·수식·병합·제외 내용을 원문과 대조하고 적용 파일·남은 질문·불일치·미지원 범위를 보고한다. 원문을 버리거나 조용히 고치지 않는다.

## 정수와 주소

XLSX 숫자 셀의 값이 정확한 정수인 경우만 이관 시 정수 문자열로 바꾼다(1.0 → 1). raw는 유지하고 normalizedInteger, import plan의 normalizations, imports/*.json에서 원문·변환값·좌표를 확인한다. 날짜·텍스트·소수·CSV/TSV에는 적용하지 않는다. 최종 값이 모두 정수 문법인 열은 integer를 제안하며 Key도 허용한다. 정규화 후 중복 Key는 자동 합치지 않는다. 일반 편집은 숫자 원문을 바꾸지 않는다. 이관은 시트 행 순서를 보존한다.

이름 안 /는 원문에 유지한다. 주소만 ./ 접두사와 단계별 ~ → ~0, / → ~1을 쓴다. 예: ./items/30~110. 기존 items/30~110은 문자 그대로의 Key다. core가 반환한 주소를 사용한다. apply의 Key/ref 값과 rename --to는 원문을 쓴다. Markdown 링크는 <...>로 감싸고 원문 %는 %25로 URI 인코딩한다. 실제 도메인 디렉터리와 .gitkeep은 CLI로만 옮긴다. 파일 이름은 Windows 안전 규칙을 지킨다.
`;
