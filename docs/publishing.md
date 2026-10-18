# Marketplace 배포

대상은 `ijun17.vibe-spec`이다. 버전 원본은 `packages/vscode/package.json`이며 `license: UNLICENSED`를 유지한다. 공개 소스 저장소는 [COLLABO-GAMES-DEV/vibe-spec-vscode-extension](https://github.com/COLLABO-GAMES-DEV/vibe-spec-vscode-extension)이며 repository·bugs·homepage도 이 주소를 사용한다. 라이선스 미정 상태이므로 `--skip-license`를 유지한다. 기존 배포 명령의 `--allow-missing-repository`는 남겨 두지만 repository 메타데이터는 제공한다.

## 실행 경로

[release.yml](../.github/workflows/release.yml)은 다음 순서로 실행한다.

1. `v*` 태그 push → [기존 Check workflow](../.github/workflows/check.yml)를 재사용해 Linux·Windows 각각 core/CLI, Playwright, 실제 VS Code 검사를 모두 실행한다. 하나라도 실패하면 뒤 단계는 실행하지 않는다.
2. 태그가 `vMAJOR.MINOR.PATCH`이며 익스텐션 `package.json` 버전과 정확히 일치하는지, publisher/name/license가 맞는지 확인한다. 프리릴리스 태그는 이번 자동화 범위가 아니다.
3. 인증 없이 Marketplace의 전체 버전 목록을 조회한다. 같은 버전이 이미 있거나 조회에 실패하면 종료한다. 기존 버전 덮어쓰기나 `--skip-duplicate`는 사용하지 않는다.
4. 빌드 후 `vsce package`로 VSIX를 만들고 Actions artifact `marketplace-vsix`에 14일간 보관한다. 파일명은 manifest 버전에서 자동으로 정한다.
5. 태그 push일 때만 `marketplace` Environment의 게시 job으로 진행한다. 승인 대기 후에는 버전 중복을 다시 확인한다.
6. 해당 VSIX를 **draft GitHub Release**에 첨부하고, 재빌드 없이 같은 파일을 `vsce publish --packagePath`로 게시한다. 성공하면 draft를 해제한다. 완료된 GitHub Release와 첨부 VSIX는 공개 저장소에서 볼 수 있다.

`main` 등 일반 브랜치 push와 PR은 Linux에서 core·CLI, Playwright(재시도 없이 1회), 실제 VS Code 검사를 실행한다. Windows 전체 검사는 `v*` 태그의 배포 검사 또는 수동 실행에서만 수행한다. **수동 Run workflow는 항상 dry-run**이며 태그를 지정해도 게시 job, Secret 접근, GitHub Release 생성은 실행하지 않는다. 게시를 켜는 수동 입력은 없다. 동시 실행은 동일 이벤트/ref별로 직렬화하며 실행 중인 배포를 자동 취소하지 않는다.

## 사용자가 한 번 준비할 것

### Azure DevOps PAT → GitHub Secret

토큰 발급·복사·등록은 사용자가 직접 한다. 채팅, 파일, 명령 인자, 로그에 토큰을 넣지 않는다. 세션이나 에이전트에 토큰을 전달하지 않는다.

1. [Marketplace 관리 화면](https://marketplace.visualstudio.com/manage)에서 Microsoft 계정에 publisher `ijun17`의 게시 권한이 있는지 확인한다.
2. 같은 계정으로 [Azure DevOps](https://dev.azure.com/)에 로그인한다. 조직이 없으면 먼저 조직을 만든다.
3. **User settings → Personal access tokens → New Token**을 연다.
4. 구분 가능한 이름과 짧은 만료일을 정한다. 공식 PAT 절차에 따라 Organization은 **All accessible organizations**, Scopes는 **Custom defined → Show all scopes → Marketplace → Manage**를 선택한다. GitHub용 PAT와는 다르다.
5. Create 후 표시되는 값을 직접 복사한다.
6. 이 GitHub 저장소의 **Settings → Secrets and variables → Actions → New repository secret**에 이름 **`VSCE_PAT`**, 값은 방금 발급한 PAT로 등록한다. 승인 환경에만 보관하려면 아래 `marketplace` Environment의 **Add environment secret**에 같은 이름으로 등록해도 된다. 둘 중 한 곳만 사용한다.
7. 만료 전에 같은 Secret 값을 교체한다. workflow는 실제 게시 step의 환경변수로만 PAT를 받는다. `vsce login`, 토큰 파일 저장, `--pat` 인자 전달은 하지 않는다. Secret이 없으면 게시 job은 Release 생성 전에 실패한다.

공식 PAT 범위와 발급 화면: [VS Code 게시 안내](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#get-a-personal-access-token). **2026-10-16 확인: global PAT는 2026-12-01 종료 예정**이다. 이번 요청대로 PAT를 사용하지만, 이후 계속 게시하려면 공식 [Microsoft Entra ID 전환 안내](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#secure-automated-publishing-to-visual-studio-marketplace)에 따라 인증 방식을 별도 작업으로 바꿔야 한다. 이 workflow는 이를 자동 전환하지 않는다.

### Environment와 승인 여부

1. 저장소 **Settings → Environments → New environment**에서 정확히 `marketplace`를 만든다.
2. Deployment branches and tags에서 선택한 태그만 허용하도록 설정하고 tag 패턴 `v*`를 추가한다.
3. **승인을 원하면** Required reviewers를 지정한다. 필요하면 Prevent self-review와 관리자 우회 금지도 설정한다. 승인 대기 전까지 검사와 VSIX 생성은 끝난 상태다.
4. **승인 없이 자동 게시하려면** Required reviewers를 설정하지 않는다. 이 경우 태그 push가 게시 의사 표시다.

Environment 이름을 workflow에 적는 것만으로 승인이 강제되지는 않는다. 공개 저장소에서도 승인을 원하면 Required reviewers를 직접 설정해야 한다. [GitHub Environment 설정](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)

새 저장소를 만들었으므로 기존 저장소의 `VSCE_PAT`와 `marketplace` 승인 설정은 자동 이전되지 않는다. 사용자가 새 저장소에서 직접 준비한다. 에이전트가 토큰 값을 읽거나 복사하지 않는다.

## 게시 없이 Windows 검사

Actions → **Check → Run workflow**에서 `platform: windows`를 선택한다. `all`은 Linux·Windows 모두 검사한다. 어느 경우도 게시·Secret 접근을 하지 않는다.

```sh
gh workflow run check.yml --repo COLLABO-GAMES-DEV/vibe-spec-vscode-extension --ref main -f platform=windows
```

태그 배포와 아래 Marketplace dry-run은 기존 reusable Check를 호출하므로 두 OS 전체 검사를 유지한다. 태그에 별도 Check 실행을 중복 등록하지 않는다.

## 게시 없이 전체 흐름 확인

1. GitHub **Actions → Marketplace release → Run workflow**를 연다.
2. 확인할 브랜치를 선택하고 `tag`에 그 브랜치 manifest와 같은 값(현재 예: `v0.7.1`)을 입력한다. 실제 태그가 없어도 된다. 게시된 버전이면 이 검증도 실패하므로, 새 버전으로 올린 브랜치에서 실행한다.
3. 전체 Linux·Windows 검사, 버전/중복 확인, VSIX 빌드가 통과하고 **publish job이 skipped**인지 확인한다.
4. Actions의 `marketplace-vsix` artifact를 내려받아 VS Code의 **Extensions → … → Install from VSIX…**로 설치해 본다.

CLI로 실행할 때도 게시하지 않는다:

```sh
gh workflow run release.yml --repo COLLABO-GAMES-DEV/vibe-spec-vscode-extension --ref main -f tag=v0.7.1
```

로컬 확인은 `node --test scripts/release.test.mjs`, `node scripts/release.mjs check v0.7.1`, `pnpm build`, `pnpm package:vsix`다. 로컬 패키지는 `artifacts/vibe-spec-<version>.vsix`에 생성된다. PAT는 필요 없다. `vsce publish`에는 dry-run 옵션이 없으므로 위 경로는 실제 게시 명령을 호출하지 않는다.

## 버전 올리기와 실제 게시

1. `packages/vscode/package.json`의 `version`을 새 안정 버전으로 올린다. 현재 관례대로 `packages/webview/package.json` 버전도 맞추고 `packages/vscode/README.md`의 버전/VSIX 예시도 갱신한다. core/CLI 내부 패키지 버전은 자동 배포 기준이 아니다.
2. `pnpm install --lockfile-only` 후 diff를 확인한다. `UNLICENSED`는 유지한다. 패키징 명령의 파일명은 자동이므로 고칠 필요가 없다.
3. 변경을 커밋·push한다. 위 dry-run을 새 버전으로 실행하고 내려받은 VSIX를 설치해 확인한다.
4. 검증한 **동일 커밋**에 태그를 만들고 그 태그만 push한다. 아래는 예시이며 아직 실행하지 않는다.

```sh
git tag -a v0.7.1 <검증한-커밋-SHA> -m "Release v0.7.1"
git push origin v0.7.1
```

5. 승인 설정을 했다면 Actions의 Review deployments에서 `marketplace`를 승인한다. 완료 후 GitHub Release 첨부와 Marketplace 버전/설치를 확인한다.

## 실패와 재실행

- 검사·태그 불일치·중복 버전·조회 실패·Secret 누락: 게시하지 않는다. 원인을 해결한 새 커밋/버전으로 진행한다. 게시된 태그를 이동하거나 삭제해 같은 버전을 덮어쓰지 않는다.
- PAT 만료나 권한 오류로 Marketplace 게시가 실패하면 draft Release가 남을 수 있다. Marketplace에 실제로 그 버전이 없는지 확인한 다음, 실패한 draft Release만 삭제하고 Secret을 고친 뒤 **Re-run failed jobs**로 게시 job을 재실행한다. 태그나 원본 artifact는 바꾸지 않는다. 14일 보관 기간이 지나면 package job까지 다시 실행해야 한다.
- Marketplace 게시는 성공했지만 마지막 Release draft 해제만 실패했다면, 다시 게시하지 않고 사용자가 해당 Release의 draft만 해제한다. 중복 버전 검사는 재게시를 실패로 알린다.
- 네트워크 응답이 끊긴 경우 성공 여부를 추측하지 말고 Marketplace 버전을 먼저 조회한다. 배포는 자동으로 취소/롤백하지 않는다.

workflow의 GitHub 권한은 기본 `contents: read`, 게시 job만 `contents: write`다. GitHub Release는 자동 `GITHUB_TOKEN`, Marketplace는 `VSCE_PAT`만 사용한다. 공유 검사 workflow에는 Secret을 전달하지 않는다.
