export const getCity = async (lat: number, lng: number) => {
  const geocode = await fetch(
    `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${process
      .env.GOOGLE_MAPS_API_KEY!}`
  );
  const data = (await geocode.json()) as any;

  return data.results[0].address_components
    .find((component: any) =>
      component.types.includes("administrative_area_level_1")
    )
    ?.long_name.replace("City", "")
    .replace(" ", "") as string;
};
