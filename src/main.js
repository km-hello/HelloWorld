import { MirrorMonumentScene } from "./scene/mirror-monument-scene.js";

const canvas = document.querySelector("[data-three-body]");

if (canvas) {
    try {
        const monument = new MirrorMonumentScene(canvas);

        monument.start().catch((error) => {
            console.error("Unable to start the mirror monument scene.", error);
            monument.destroy();
            document.body.classList.remove("scene-ready");
            document.body.classList.add("scene-failed");
            canvas.dataset.simulationState = "failed";
        });
    } catch (error) {
        console.error("WebGL mirror monument is unavailable.", error);
        document.body.classList.add("scene-failed");
        canvas.dataset.simulationState = "failed";
    }
}
