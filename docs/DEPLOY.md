# 배포와 설치 파일 릴리스

## 웹 배포

`.github/workflows/deploy-web.yml`이 `main`에 푸시할 때마다 웹 빌드를 올려요. **저장소 변수 `DEPLOY_TARGET`을 정하기 전까지는 아무것도 배포하지 않아요.**
빌드는 상대 경로(`base: "./"`)라서 `https://아이디.github.io/Yobsidian/` 같은 하위 경로에서도, `https://yobsidian.pages.dev/` 같은 루트에서도 그대로 동작해요.

### 호스트 고르기

| | GitHub Pages | Cloudflare Pages |
| --- | --- | --- |
| 비용 | 비공개 저장소에서 쓰려면 **유료 플랜(Pro 이상)** 필요. 무료 계정은 저장소를 공개해야 해요. | 무료. 비공개 저장소도 돼요. |
| 주소 | `https://choiyoh.github.io/Yobsidian/` | `https://yobsidian.pages.dev` (프로젝트 이름이 같으면) |
| 설정 | 변수 1개 + Pages 소스 선택 | 변수 1개 + 비밀값 2개 + 프로젝트 1개 |

이 저장소는 **비공개**라서, 유료 플랜이 없다면 **Cloudflare Pages**를 추천해요. 어느 쪽이든 사이트 주소는 누구나 열 수 있어요(노트는 내 브라우저와 내 구글 드라이브에만 있어서 괜찮아요).

### GitHub Pages로 배포할 때

1. 저장소 **Settings → Pages → Build and deployment → Source**를 **GitHub Actions**로 바꿉니다.
2. **Settings → Secrets and variables → Actions → Variables**에 `DEPLOY_TARGET` = `github-pages` 를 추가합니다.
3. `main`에 푸시하거나 **Actions → Deploy web → Run workflow**를 누릅니다.

### Cloudflare Pages로 배포할 때

1. <https://dash.cloudflare.com/> 에서 무료 계정을 만들고, **Workers & Pages → Create → Pages → Direct Upload**로 프로젝트를 `yobsidian` 이름으로 만듭니다. (다른 이름이면 변수 `CLOUDFLARE_PROJECT`에 적어요.)
2. **My Profile → API Tokens → Create Token**에서 *Cloudflare Pages: Edit* 권한의 토큰을 만들고, 오른쪽 사이드바의 **Account ID**도 복사합니다.
3. 저장소 **Settings → Secrets and variables → Actions**에 비밀값 `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, 변수 `DEPLOY_TARGET` = `cloudflare` 를 추가합니다.
4. `main`에 푸시하거나 **Actions → Deploy web → Run workflow**를 누릅니다.

### 구글 로그인 연결

배포된 주소(경로 빼고 origin만, 예: `https://choiyoh.github.io` 또는 `https://yobsidian.pages.dev`)를 [구글 설정 가이드](GOOGLE_SETUP.md)의 **승인된 JavaScript 원본**에 추가하세요.
클라이언트 ID는 코드에 기본값이 들어 있어서 따로 설정하지 않아도 돼요. 다른 클라이언트를 쓰고 싶으면 저장소 **변수** `VITE_GOOGLE_CLIENT_ID`에 적으세요(비어 있으면 기본값을 써요). 앱 안의 ☁ 메뉴에서 입력한 값이 가장 우선해요. **클라이언트 보안 비밀은 웹 빌드에 넣지 마세요.**

### 설치하기와 오프라인

배포된 주소를 크롬·엣지로 열면 주소창 오른쪽에 **설치** 아이콘이 떠요. 사파리(맥)는 **파일 → Dock에 추가**, iPhone은 **공유 → 홈 화면에 추가**입니다.
첫 방문에서 앱 파일이 브라우저에 저장되고, 그다음부터는 인터넷이 없어도 열려요. 새 버전을 배포하면 다음에 열 때 받아 두었다가, **그다음 실행부터** 바뀝니다(새로고침을 한 번 더 하면 바로 바뀌어요).

## 데스크톱 설치 파일 (윈도우·맥)

`.github/workflows/release.yml`이 `v`로 시작하는 태그를 푸시하면 설치 파일을 빌드해서 GitHub Release에 붙여요.

```bash
# package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml 의 version 을 같은 값(예: 0.2.0)으로 올리고 main에 합친 뒤
git tag v0.2.0
git push origin v0.2.0
```

데스크톱 구글 로그인에는 클라이언트 보안 비밀이 필요해요. 공개 저장소에 값을 올릴 수 없어서, 첫 릴리스 전에 저장소 **Settings → Secrets and variables → Actions → Secrets**에 `VITE_GOOGLE_CLIENT_SECRET`을 등록해 두세요(값은 구글 콘솔의 데스크톱 클라이언트에서 복사). 릴리스 워크플로가 빌드할 때 이 값을 넘겨요. 없으면 빌드는 되지만 설치 파일에서 로그인할 때 안내 오류가 떠요. 자세한 내용은 [구글 설정 가이드](GOOGLE_SETUP.md)를 보세요.

태그와 `tauri.conf.json`의 버전이 다르면 빌드를 멈춰요. 끝나면 저장소의 **Releases**에 아래 파일이 생겨요. 저장소가 공개면 누구나 받을 수 있고, 비공개면 내 GitHub 계정으로 로그인해야 받을 수 있어요.

- 윈도우: `Yobsidian_<버전>_x64-setup.exe`(설치 프로그램), `.msi`
- 맥: `Yobsidian_<버전>_universal.dmg` (애플 실리콘·인텔 모두)

### 설치 파일 열기 (서명하지 않은 앱 경고)

코드 서명 인증서와 애플 공증은 유료라서 쓰지 않아요. 그래서 처음 한 번은 운영체제가 경고를 보여요. 내가 직접 빌드한 앱이니 아래대로 열면 돼요. 한 번 열면 그다음부터는 묻지 않아요.

**윈도우 (SmartScreen)**
1. 설치 파일을 실행하면 "Windows의 PC 보호" 화면이 떠요.
2. **추가 정보**를 누르면 **실행** 버튼이 나타나요. 누르세요.
3. 브라우저가 다운로드를 막으면 다운로드 목록에서 **보관**을 고르세요.

**맥 (Gatekeeper)**
1. `.dmg`를 열고 Yobsidian을 **응용 프로그램**으로 끌어다 놓습니다.
2. 응용 프로그램에서 Yobsidian을 **우클릭 → 열기 → 열기**. (더블 클릭은 막혀요.)
3. "손상되었기 때문에 열 수 없음"이 뜨면 터미널에서 한 번만 실행하세요.
   ```bash
   xattr -dr com.apple.quarantine /Applications/Yobsidian.app
   ```
   macOS 15 이상에서 우클릭 열기가 안 보이면 **시스템 설정 → 개인정보 보호 및 보안**에서 맨 아래 **그래도 열기**를 누르세요.

## 내가 직접 눌러야 하는 것

- [ ] 웹 호스트 고르기 → 위 "GitHub Pages로" 또는 "Cloudflare Pages로" 단계 따라 하기 (변수 `DEPLOY_TARGET`이 없으면 배포는 건너뛰어요)
- [ ] 배포된 주소의 origin을 구글 클라이언트의 **승인된 JavaScript 원본**에 추가
- [ ] (선택) 변수 `VITE_GOOGLE_CLIENT_ID` 추가 (다른 클라이언트를 쓸 때만)
- [ ] 저장소 Actions **Secret** `VITE_GOOGLE_CLIENT_SECRET` 등록 (데스크톱 클라이언트의 보안 비밀. 구글 콘솔 → 클라이언트에서 확인)
- [ ] 첫 릴리스: 태그 `v0.1.0` 푸시 (`git tag v0.1.0 && git push origin v0.1.0`)
