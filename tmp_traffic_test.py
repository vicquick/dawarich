import asyncio, json
from playwright.async_api import async_playwright

EXEC = "/home/appuser/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome"
FLAGS = ["--use-gl=angle","--use-angle=swiftshader-webgl","--enable-unsafe-swiftshader",
         "--enable-webgl","--ignore-gpu-blocklist","--no-sandbox"]
URL = "https://maps.budinic.art/map/v2"

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=EXEC, args=FLAGS, headless=True)
        ctx = await b.new_context(viewport={"width":390,"height":844},
            user_agent="Mozilla/5.0 (Linux; Android 13; OnePlus) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36")
        pg = await ctx.new_page()
        logs=[]
        pg.on("console", lambda m: logs.append(m.text))
        # login
        await pg.goto("https://maps.budinic.art/users/sign_in", wait_until="networkidle")
        await pg.fill('input[name="user[email]"]', "shotbot@local.test")
        await pg.fill('input[name="user[password]"]', "Shotbot!2026xZ")
        async with pg.expect_navigation(wait_until="networkidle"):
            await pg.click('input[type=submit], button:has-text("Log in")')
        print("after-login url:", pg.url)
        await pg.goto(URL, wait_until="networkidle")
        await pg.wait_for_timeout(6000)
        # center on Hamburg/Lüneburg area where NAPSPAN has closures
        await pg.evaluate("""() => { if(window.dawarichMap){ window.dawarichMap.jumpTo({center:[10.0,53.5],zoom:10}); } }""")
        await pg.wait_for_timeout(1500)
        # toggle traffic
        btn = await pg.query_selector('.traffic-toggle__btn')
        print("traffic btn present:", bool(btn))
        if btn:
            await btn.click()
            await pg.wait_for_timeout(4000)
            pressed = await btn.get_attribute('aria-pressed')
            count = await btn.get_attribute('data-count')
            print("aria-pressed:", pressed, "data-count:", count)
            # check layers exist
            info = await pg.evaluate("""() => {
                const m = window.dawarichMap; if(!m) return {err:'no map'};
                const src = m.getSource('napspan-incidents');
                let n=0; try { n = src && src._data && src._data.features ? src._data.features.length : -1 } catch(e){}
                return { hasLines: !!m.getLayer('napspan-lines'), hasPoints: !!m.getLayer('napspan-points'),
                         hasSource: !!src, feats: n };
            }""")
            print("layers:", json.dumps(info))
        await pg.screenshot(path="/tmp/traffic_test.png")
        # interactive-during-routing: check backdrop pointer-events when routing
        # open a place + directions is complex; instead assert backdrop not blocking by default
        bd = await pg.evaluate("""() => {
            const el = document.getElementById('place-sheet-backdrop');
            if(!el) return {exists:false};
            const cs = getComputedStyle(el);
            return {exists:true, pe: cs.pointerEvents, opacity: cs.opacity, display: cs.display};
        }""")
        print("backdrop:", json.dumps(bd))
        print("CONSOLE_ERRORS:", [l for l in logs if 'rror' in l][:5])
        await b.close()

asyncio.run(main())
