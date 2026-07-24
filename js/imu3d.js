/**
 * Three.js 3D IMU Attitude & Flight Visualizer (3D 陀螺仪姿态解算模块)
 */
class IMU3DVisualizer {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    if (!this.container) return;

    this.roll = 0;  // Deg X
    this.pitch = 0; // Deg Y
    this.yaw = 0;   // Deg Z

    this.modelType = 'board'; // 'board' | 'drone' | 'cube'
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.targetMesh = null;

    this.initThree();
  }

  initThree() {
    const width = this.container.clientWidth || 600;
    const height = this.container.clientHeight || 400;

    // 1. Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x080c14);

    // 2. Camera
    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    this.camera.position.set(0, 5, 10);
    this.camera.lookAt(0, 0, 0);

    // 3. Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.container.appendChild(this.renderer.domElement);

    // 4. Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0x00f3ff, 1.2);
    dirLight.position.set(5, 10, 7);
    this.scene.add(dirLight);

    const purpleLight = new THREE.DirectionalLight(0x9d4edd, 0.8);
    purpleLight.position.set(-5, -5, -5);
    this.scene.add(purpleLight);

    // 5. Grid Helper & Axes
    const grid = new THREE.GridHelper(20, 20, 0x00f3ff, 0x182030);
    grid.position.y = -2;
    this.scene.add(grid);

    // Axes Helper (Red=X, Green=Y, Blue=Z)
    const axesHelper = new THREE.AxesHelper(3);
    this.scene.add(axesHelper);

    // 6. Build initial 3D Model
    this.buildModel();

    // Listen for resize
    window.addEventListener('resize', () => this.onResize());

    // Render loop
    const animate = () => {
      requestAnimationFrame(animate);
      if (this.targetMesh) {
        // Convert Roll, Pitch, Yaw from Degrees to Radians
        const radRoll = THREE.MathUtils.degToRad(this.roll);
        const radPitch = THREE.MathUtils.degToRad(this.pitch);
        const radYaw = THREE.MathUtils.degToRad(this.yaw);

        // Smooth Euler rotation
        this.targetMesh.rotation.set(radPitch, radYaw, radRoll, 'YXZ');
      }
      this.renderer.render(this.scene, this.camera);
    };
    animate();
  }

  buildModel() {
    if (this.targetMesh) {
      this.scene.remove(this.targetMesh);
    }

    const group = new THREE.Group();

    if (this.modelType === 'board') {
      // High-Tech PCB Board Model
      const boardGeo = new THREE.BoxGeometry(4, 0.2, 3);
      const boardMat = new THREE.MeshStandardMaterial({
        color: 0x0b3c26, // Green PCB
        roughness: 0.3,
        metalness: 0.5
      });
      const board = new THREE.Mesh(boardGeo, boardMat);
      group.add(board);

      // Microcontroller Chip (STM32/ESP32)
      const chipGeo = new THREE.BoxGeometry(1.2, 0.25, 1.2);
      const chipMat = new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 0.8 });
      const chip = new THREE.Mesh(chipGeo, chipMat);
      chip.position.y = 0.15;
      group.add(chip);

      // Glowing Antenna / Sensors
      const sensorGeo = new THREE.BoxGeometry(0.5, 0.3, 0.5);
      const sensorMat = new THREE.MeshStandardMaterial({ color: 0x00f3ff, emissive: 0x00f3ff, emissiveIntensity: 0.8 });
      const sensor = new THREE.Mesh(sensorGeo, sensorMat);
      sensor.position.set(1.2, 0.2, 0.8);
      group.add(sensor);

    } else if (this.modelType === 'drone') {
      // Quadcopter Drone Model
      const centerGeo = new THREE.CylinderGeometry(0.8, 0.8, 0.3, 16);
      const centerMat = new THREE.MeshStandardMaterial({ color: 0x182030, metalness: 0.7 });
      const center = new THREE.Mesh(centerGeo, centerMat);
      group.add(center);

      // 4 Arms
      for (let i = 0; i < 4; i++) {
        const angle = (Math.PI / 2) * i + Math.PI / 4;
        const armGeo = new THREE.BoxGeometry(3, 0.1, 0.2);
        const armMat = new THREE.MeshStandardMaterial({ color: 0x00f3ff });
        const arm = new THREE.Mesh(armGeo, armMat);
        arm.rotation.y = angle;
        group.add(arm);

        // Motor/Rotor caps
        const propGeo = new THREE.CylinderGeometry(0.8, 0.8, 0.05, 16);
        const propMat = new THREE.MeshStandardMaterial({ color: 0x9d4edd, transparent: true, opacity: 0.7 });
        const prop = new THREE.Mesh(propGeo, propMat);
        prop.position.set(Math.cos(angle) * 1.5, 0.2, Math.sin(angle) * 1.5);
        group.add(prop);
      }

    } else {
      // Cube Model
      const cubeGeo = new THREE.BoxGeometry(3, 3, 3);
      const cubeMat = new THREE.MeshStandardMaterial({
        color: 0x121824,
        wireframe: false,
        roughness: 0.2,
        metalness: 0.8
      });
      const cube = new THREE.Mesh(cubeGeo, cubeMat);
      group.add(cube);
    }

    this.targetMesh = group;
    this.scene.add(this.targetMesh);
  }

  setModelType(type) {
    this.modelType = type;
    this.buildModel();
  }

  updateAttitude(roll, pitch, yaw) {
    if (!isNaN(roll)) this.roll = roll;
    if (!isNaN(pitch)) this.pitch = pitch;
    if (!isNaN(yaw)) this.yaw = yaw;
  }

  resetView() {
    this.roll = 0;
    this.pitch = 0;
    this.yaw = 0;
    if (this.camera) {
      this.camera.position.set(0, 5, 10);
      this.camera.lookAt(0, 0, 0);
    }
  }

  onResize() {
    if (!this.container || !this.renderer || !this.camera) return;
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }
}

window.IMU3DVisualizer = IMU3DVisualizer;
